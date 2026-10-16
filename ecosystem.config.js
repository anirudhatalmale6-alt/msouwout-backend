module.exports = {
  apps: [{
    name: 'msouwout-api',
    script: 'src/server.js',
    cwd: '/var/lib/freelancer/projects/40266451/msouwout-backend',
    env: {
      PORT: 8093,
      NODE_ENV: 'production',
      ADMIN_SECRET: process.env.ADMIN_SECRET   // 16 Oct 2026: never a value in the code
    }
  }]
};
