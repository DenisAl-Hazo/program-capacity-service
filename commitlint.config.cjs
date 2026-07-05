module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'chore', 'build', 'style', 'ci', 'revert'],
    ],
    'scope-enum': [
      1,
      'always',
      ['programs', 'reservations', 'ledger', 'treasury', 'fx', 'idempotency', 'auth', 'db', 'config', 'docker'],
    ],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 72],
  },
};
