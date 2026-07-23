import path from 'node:path';
import { validateFoodSeedArtifacts } from './food-seed/validation.ts';

const outputDir = process.argv[2] ?? path.join(process.cwd(), 'generated', 'food-seed');

validateFoodSeedArtifacts(outputDir)
  .then((report) => {
    process.stdout.write(
      `Food seed validation ${report.status.toUpperCase()}: ${report.summary.checksPassed} passed, ${report.summary.checksFailed} failed\n`
    );
    if (report.status === 'fail') process.exitCode = 1;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Food seed validation could not run: ${message}\n`);
    process.exitCode = 1;
  });
