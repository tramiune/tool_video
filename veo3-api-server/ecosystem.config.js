module.exports = {
  apps: [{
    name: 'veo3-api-server',
    script: './src/server.js',
    cwd: '/root/meo3/veo3-api-server',
    env: {
      PORT: 3456,
      VIDEO_CONCURRENCY: '6',
      IMAGE_CONCURRENCY: '3',
      DOWNLOAD_CONCURRENCY: '2'
    }
  }]
};
