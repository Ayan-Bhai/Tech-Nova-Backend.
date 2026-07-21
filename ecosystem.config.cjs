module.exports = {
  apps: [{
    name: 'backend',
    script: 'src/index.js',
    cwd: '/home/user/webapp/backend',
    env: { NODE_ENV: 'development' },
    watch: false,
    instances: 1,
    exec_mode: 'fork'
  }]
}
