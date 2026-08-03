export function materializedNpmArtifactEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "npm_config_dry_run") {
      delete environment[key];
    }
  }
  return environment;
}
