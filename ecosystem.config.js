// PM2 Configuration for Production
// Install: npm install -g pm2
// Start: pm2 start ecosystem.config.js
// Monitor: pm2 monit
// Logs: pm2 logs

module.exports = {
  apps: [{
    name: 'ytdownloader-api',
    script: './server.optimized.js',
    
    // Clustering (use all CPU cores)
    instances: 'max', // or specific number like 4
    exec_mode: 'cluster',
    
    // Auto-restart
    autorestart: true,
    watch: false, // Set to true in development
    max_memory_restart: '500M', // Restart if memory exceeds 500MB
    
    // Environment variables
    env: {
      NODE_ENV: 'development',
      PORT: 3000
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    
    // Logging
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    
    // Advanced
    max_restarts: 10,
    min_uptime: '10s',
    listen_timeout: 10000,
    kill_timeout: 5000,
    
    // Graceful shutdown
    wait_ready: true,
    shutdown_with_message: true
  }]
};
