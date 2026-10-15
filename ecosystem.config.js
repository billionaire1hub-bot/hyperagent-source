module.exports = {
  apps: [
    {
      name: "hyperagent",
      script: "artifacts/api-server/dist/index.js",
      // Keep exactly one instance: the autonomous loops and in-memory cache must
      // not be duplicated across workers.
      instances: 1,
      exec_mode: "fork",
      // Restart automatically if the process ever exits, with sane backoff so a
      // crash loop cannot hammer the host.
      autorestart: true,
      max_restarts: 1000,
      min_uptime: "10s",
      restart_delay: 4000,
      exp_backoff_restart_delay: 200,
      // Give graceful shutdown (worker stop + server close) time to run.
      kill_timeout: 15000,
      wait_ready: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
      },
      // Structured logs; rotate to avoid unbounded disk use on a 24/7 host.
      merge_logs: true,
      time: true,
    },
  ],
};
