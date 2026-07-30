export default {
  branches: ['main'],
  tagFormat: 'food-seed-semver-v${version}',
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/exec',
      {
        prepareCmd:
          'npm run --silent release:version -- ${nextRelease.version} ${nextRelease.type}',
        publishCmd: 'gh workflow run build-food-seed.yml --ref main',
      },
    ],
    [
      '@semantic-release/git',
      {
        assets: ['inputs/manifest.json'],
        message:
          'chore(release): food seed ${nextRelease.version} [skip ci]\n\n' +
          '${nextRelease.notes}\n\n' +
          'Co-Authored-By: Paperclip <noreply@paperclip.ing>',
      },
    ],
  ],
};
