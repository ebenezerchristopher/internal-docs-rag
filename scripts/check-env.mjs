#!/usr/bin/env node
// Print which required env vars are set / missing, without making any API calls.

const REQUIRED = [
  "EMBEDDING_BASE_URL",
  "EMBEDDING_API_KEY",
  "EMBEDDING_MODEL",
  "GENERATION_BASE_URL",
  "GENERATION_API_KEY",
  "GENERATION_MODEL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

const OPTIONAL = ["SIMILARITY_THRESHOLD"];

let ok = true;
for (const k of REQUIRED) {
  if (process.env[k]) {
    const v = process.env[k];
    const masked = k.includes("KEY") ? `${v.slice(0, 4)}...${v.slice(-4)}` : v;
    console.log(`  [ok]   ${k} = ${masked}`);
  } else {
    console.log(`  [miss] ${k}`);
    ok = false;
  }
}
for (const k of OPTIONAL) {
  if (process.env[k]) {
    console.log(`  [opt]  ${k} = ${process.env[k]}`);
  } else {
    console.log(`  [opt]  ${k} (unset, using default)`);
  }
}

if (!ok) {
  console.error("\nSome required env vars are missing. See .env.example.");
  process.exit(1);
}
console.log("\nAll required env vars are set.");
