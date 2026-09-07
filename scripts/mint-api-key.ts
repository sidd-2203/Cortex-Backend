// Mints a public-API key for a given user. Script-issued by design (see the
// bonus-scope scoping conversation) — no self-serve UI in this pass.
//
// Usage: npx tsx scripts/mint-api-key.ts <userId-or-email> [name]
//
// Prints the full key exactly once. It is never stored or retrievable again
// after this — only its SHA-256 hash and its first 16 chars (for display in
// a future listing) are persisted (see prisma/schema.prisma's ApiKey model).

import "dotenv/config";
import { prisma } from "../src/lib/db";
import { generateApiKey } from "../src/lib/auth-api-key";

async function main() {
  const [identifier, name] = process.argv.slice(2);
  if (!identifier) {
    console.error("Usage: npx tsx scripts/mint-api-key.ts <userId-or-email> [name]");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({
    where: { OR: [{ id: identifier }, { email: identifier }] },
  });
  if (!user) {
    console.error(`No user found with id or email "${identifier}" — they need to have signed into Cortex at least once first.`);
    process.exit(1);
  }

  const { key, keyPrefix, hashedKey } = generateApiKey();
  await prisma.apiKey.create({
    data: { ownerId: user.id, name: name ?? "default", keyPrefix, hashedKey },
  });

  console.log(`\nAPI key created for ${user.email} (${user.id}):\n`);
  console.log(`  ${key}\n`);
  console.log("This is shown once — it is not stored anywhere retrievable. Save it now.");
  console.log('Use it as: Authorization: Bearer <key>\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
