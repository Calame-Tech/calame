module.exports = {
  '*.{ts,tsx}': ['prettier --write', 'eslint --fix'],
  '*.{js,cjs,mjs}': ['prettier --write', 'eslint --fix'],
  '*.{json,md,yml,yaml}': ['prettier --write'],
};
