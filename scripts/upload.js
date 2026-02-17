#!/usr/bin/env node
const { execSync } = require("child_process");

const slug = process.argv[2];
const file = process.argv[3];

if (!slug || !file) {
  console.error("Usage: npm run upload -- <slug-or-path> <filepath>");
  console.error("");
  console.error("Examples:");
  console.error("  npm run upload -- brand-guidelines-starter-kit ./file.zip");
  console.error('  npm run upload -- "New Opening Products/file.zip" ./file.zip');
  process.exit(1);
}

const key = slug.includes("/") ? slug : `products/${slug}.zip`;

console.log(`Uploading "${file}" to R2 key: ${key}`);
execSync(`npx wrangler r2 object put "new-opening-supply/${key}" --file="${file}"`, {
  stdio: "inherit",
});
console.log("Done.");
