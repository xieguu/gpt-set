const fs = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const clientRoot = path.resolve(__dirname, '..');
  const source = path.resolve(clientRoot, '..', 'chatgpt-image-bridge-extension');
  const destination = path.join(clientRoot, 'dist', 'chatgpt-image-bridge-extension');
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(source, destination, { recursive: true, force: true });
  console.log(`Image bridge extension copied to ${destination}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
