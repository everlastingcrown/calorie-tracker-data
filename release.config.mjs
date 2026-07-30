export default {
  branches: ['main'],
  tagFormat: 'food-seed-semver-v${version}',
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/exec',
      {
        publishCmd:
          'gh workflow run build-food-seed.yml --ref main ' +
          '-f seed_version=${nextRelease.version} ' +
          '-f release_type=${nextRelease.type}',
      },
    ],
  ],
};
