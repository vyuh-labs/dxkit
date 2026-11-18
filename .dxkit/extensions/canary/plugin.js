require('fs').writeFileSync("/tmp/dxkit-canary-out-qgZXPw/PLUGIN_FIRED", 'fired');
module.exports = {
  name: 'canary',
  sdkMajor: 0,
  httpFlowDialect: {
    pack: 'typescript',
    clientMethodCallees: { methods: ['fetchJson'] },
    methodAliases: { fetchjson: 'GET' },
  },
};
