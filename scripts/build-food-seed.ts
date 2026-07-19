import { buildFoodSeedArtifacts, parseBuildArgs } from './food-seed/pipeline.ts';
import path from 'node:path';
import { readFoodSeedInputManifest } from './food-seed/input-manifest.ts';
import { createSeedRelease } from './food-seed/release-manifest.ts';

async function main(): Promise<void> {
  const args = parseBuildArgs(process.argv.slice(2));
  const manifest = await readFoodSeedInputManifest(
    path.join(process.cwd(), 'inputs', 'manifest.json')
  );
  const release = createSeedRelease({
    ...manifest.seedVersion,
    runAt: process.env.FOOD_SEED_RUN_AT ?? new Date().toISOString(),
    verified: process.env.FOOD_SEED_VERIFIED === 'true',
  });
  const summary = await buildFoodSeedArtifacts({ ...args, release });

  process.stdout.write(`Built food seed artifacts in ${summary.outputDir}\n`);
  process.stdout.write(`- version: ${release.versionId} (${release.verified ? 'verified' : 'unverified'})\n`);
  process.stdout.write(`- foods.seed.json.gz: ${summary.genericSeedCount} generic foods\n`);
  process.stdout.write(`- foods-{country}.branded.json.gz: ${summary.brandedSeedCount} branded foods\n`);
  process.stdout.write(`- foods.manifest.json: ${summary.sourceCount} sources\n`);
  process.stdout.write(
    `- foods.qa.json: ${summary.rejectedCount} rejected rows, ${summary.duplicateCount} duplicate groups\n`
  );
  process.stdout.write('- foods.energy-discrepancies.json: kJ/kcal validation results\n');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
