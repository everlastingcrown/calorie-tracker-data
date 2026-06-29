import type { FoodSeedInputManifest, FoodSeedManifestSource } from './input-manifest.ts';

export function buildFoodSeedReleaseNotes(manifest: FoodSeedInputManifest): string {
  const enabledSources = manifest.sources.filter((source) => source.enabled);
  const sections = [
    'Food seed artifacts built from public source files in `inputs/manifest.json`.',
    '',
    '## Included sources',
    ...enabledSources.flatMap(formatSource),
    '',
    '## License and attribution',
    ...enabledSources.flatMap(formatSourceLicense),
  ];

  return `${sections.join('\n')}\n`;
}

function formatSource(source: FoodSeedManifestSource): string[] {
  const lines = [
    '',
    `- ${source.title}`,
    `  - Version: ${source.version}`,
    `  - Manifest source id: \`${source.id}\``,
  ];

  if (source.notes) {
    lines.push(`  - Notes: ${source.notes}`);
  }

  return lines;
}

function formatSourceLicense(source: FoodSeedManifestSource): string[] {
  const lines = [
    '',
    `- ${source.title}`,
    `  - License: [${source.license.name}](${source.license.url})`,
    `  - Attribution: ${source.license.attribution}`,
  ];

  if (source.license.notes) {
    lines.push(`  - Notes: ${source.license.notes}`);
  }

  return lines;
}
