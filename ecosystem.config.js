module.exports = {
  apps: [{
    name: 'msouwout-api',
    script: 'src/server.js',
    cwd: '/var/lib/freelancer/projects/40266451/msouwout-backend',
    env: {
      PORT: 8093,
      NODE_ENV: 'production',
      ADMIN_SECRET: 'msouwout-admin-2026'
    }
  }]
};
