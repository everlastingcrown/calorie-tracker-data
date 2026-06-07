import { buildFoodSeedArtifacts, parseBuildArgs } from './food-seed/pipeline.ts';

async function main(): Promise<void> {
  const args = parseBuildArgs(process.argv.slice(2));
  const summary = await buildFoodSeedArtifacts(args);

  process.stdout.write(`Built food seed artifacts in ${summary.outputDir}\n`);
  process.stdout.write(`- foods.seed.json: ${summary.genericSeedCount} generic foods\n`);
  process.stdout.write(`- foods-{country}.branded.json: ${summary.brandedSeedCount} branded foods\n`);
  process.stdout.write(`- foods.manifest.json: ${summary.sourceCount} sources\n`);
  process.stdout.write(
    `- foods.qa.json: ${summary.rejectedCount} rejected rows, ${summary.duplicateCount} duplicate groups\n`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
