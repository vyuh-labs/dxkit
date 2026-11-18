module.exports = {
  name: 'acme-dialect',
  sdkMajor: 0,
  httpFlowDialect: {
    pack: 'typescript',
    clientMethodCallees: { methods: ['fetchJson'] },
    methodAliases: { fetchjson: 'GET' },
  },
};