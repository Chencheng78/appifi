var validator = require('validator')

const isUUID = typeof uuid === 'string' && validator.isUUID(uuid)
const isSHA256 = (hash) => /[a-f0-9]{64}/.test(hash)
