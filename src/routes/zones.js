const express = require('express');
const pool = require('../db/pool');
const router = express.Router();

// GET /api/zones - List all zones
router.get('/', async (req, res) => {
  try {
    const { active, type } = req.query;
    let query = `
      SELECT id, name, description, zone_type, service_rule, is_active,
             active_from, active_until, active_days, geometry,
             created_at, updated_at, created_by
      FROM zones
    `;
    const conditions = [];
    const params = [];

    if (active !== undefined) {
      params.push(active === 'true');
      conditions.push(`is_active = $${params.length}`);
    }
    if (type) {
      params.push(type);
      conditions.push(`zone_type = $${params.length}`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY zone_type, name';

    const result = await pool.query(query, params);

    // Convert to GeoJSON FeatureCollection
    const features = result.rows.map(row => {
      const geojson = typeof row.geometry === 'string' ? JSON.parse(row.geometry) : row.geometry;
      return {
        type: 'Feature',
        properties: {
          id: row.id,
          name: row.name,
          description: row.description,
          zone_type: row.zone_type,
          service_rule: row.service_rule,
          is_active: row.is_active,
          active_from: row.active_from,
          active_until: row.active_until,
          active_days: row.active_days,
          created_at: row.created_at,
          updated_at: row.updated_at,
          created_by: row.created_by
        },
        geometry: geojson
      };
    });

    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error('Error fetching zones:', err);
    res.status(500).json({ error: 'Failed to fetch zones' });
  }
});

// POST /api/zones - Create a new zone
router.post('/', async (req, res) => {
  try {
    const { name, description, zone_type, geometry, service_rule, is_active,
            active_from, active_until, active_days, created_by } = req.body;

    if (!name || !zone_type || !geometry) {
      return res.status(400).json({ error: 'name, zone_type, and geometry are required' });
    }

    const geojson = typeof geometry === 'string' ? geometry : JSON.stringify(geometry);

    const result = await pool.query(`
      INSERT INTO zones (name, description, zone_type, geometry, service_rule, is_active,
                         active_from, active_until, active_days, created_by)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
      RETURNING id, name, zone_type, service_rule, is_active, created_at
    `, [
      name, description || null, zone_type, geojson,
      service_rule || 'both', is_active !== false,
      active_from || null, active_until || null, active_days || null,
      created_by || 'admin'
    ]);

    await pool.query(`
      INSERT INTO zone_audit_log (zone_id, action, changed_by, details)
      VALUES ($1, 'created', $2, $3)
    `, [result.rows[0].id, created_by || 'admin', JSON.stringify({ name, zone_type })]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating zone:', err);
    res.status(500).json({ error: 'Failed to create zone' });
  }
});

// PUT /api/zones/:id - Update a zone
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, zone_type, geometry, service_rule, is_active,
            active_from, active_until, active_days, updated_by } = req.body;

    let query, params;

    if (geometry) {
      const geojson = typeof geometry === 'string' ? geometry : JSON.stringify(geometry);
      query = `
        UPDATE zones SET
          name = COALESCE($2, name),
          description = COALESCE($3, description),
          zone_type = COALESCE($4, zone_type),
          geometry = $5::jsonb,
          service_rule = COALESCE($6, service_rule),
          is_active = COALESCE($7, is_active),
          active_from = $8, active_until = $9, active_days = $10,
          updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, zone_type, is_active, updated_at
      `;
      params = [id, name, description, zone_type, geojson, service_rule,
                is_active, active_from || null, active_until || null, active_days || null];
    } else {
      query = `
        UPDATE zones SET
          name = COALESCE($2, name),
          description = COALESCE($3, description),
          zone_type = COALESCE($4, zone_type),
          service_rule = COALESCE($5, service_rule),
          is_active = COALESCE($6, is_active),
          active_from = $7, active_until = $8, active_days = $9,
          updated_at = NOW()
        WHERE id = $1
        RETURNING id, name, zone_type, is_active, updated_at
      `;
      params = [id, name, description, zone_type, service_rule,
                is_active, active_from || null, active_until || null, active_days || null];
    }

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    await pool.query(`
      INSERT INTO zone_audit_log (zone_id, action, changed_by, details)
      VALUES ($1, 'updated', $2, $3)
    `, [id, updated_by || 'admin', JSON.stringify(req.body)]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating zone:', err);
    res.status(500).json({ error: 'Failed to update zone' });
  }
});

// PATCH /api/zones/:id/toggle - Quick toggle active/inactive
router.patch('/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      UPDATE zones SET is_active = NOT is_active, updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, zone_type, is_active
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    const action = result.rows[0].is_active ? 'activated' : 'deactivated';
    await pool.query(`
      INSERT INTO zone_audit_log (zone_id, action, changed_by)
      VALUES ($1, $2, 'admin')
    `, [id, action]);

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error toggling zone:', err);
    res.status(500).json({ error: 'Failed to toggle zone' });
  }
});

// DELETE /api/zones/:id
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM zones WHERE id = $1 RETURNING id, name', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    await pool.query(`
      INSERT INTO zone_audit_log (zone_id, action, changed_by, details)
      VALUES ($1, 'deleted', 'admin', $2)
    `, [id, JSON.stringify({ name: result.rows[0].name })]);

    res.json({ deleted: true, id });
  } catch (err) {
    console.error('Error deleting zone:', err);
    res.status(500).json({ error: 'Failed to delete zone' });
  }
});

// GET /api/zones/stats - Zone statistics
router.get('/stats', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        zone_type,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE is_active) as active_count
      FROM zones
      GROUP BY zone_type
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
