import fs from "fs/promises"; // Use promise-based fs for async/await
import path from "path";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { typesBundleForPolkadot } from "@crustio/type-definitions";
import { Keyring } from "@polkadot/keyring";
import { PrismaClient } from "@prisma/client";
import "dotenv/config"; // Load environment variables from .env file

// --- Configuration ---
const config = {
  crustChainEndpoint:
    process.env.CRUST_CHAIN_ENDPOINT || "wss://rpc.crust.network",
  crustSeeds: process.env.CRUST_SEEDS,
  ipfsGatewayUrl: process.env.IPFS_GATEWAY_URL || "https://gw.crustgw.work",
  progressFile: path.resolve("migration-progress.json"),
  defaultFileSize: 1_000_000,
};

if (!config.crustSeeds) {
  console.error(
    "🔥 CRUST_SEEDS environment variable not set. Please create a .env file."
  );
  process.exit(1);
}

// --- Main Execution Logic ---
async function main() {
  let api;
  const prisma = new PrismaClient();

  try {
    console.log("[INFO] Starting migration script...");
    const progress = await loadProgress(config.progressFile);

    console.log("🔗 Connecting to Crust chain...");
    api = await connectToCrust(config.crustChainEndpoint);
    console.log("✅ Connected to Crust chain.");

    const keyring = new Keyring({ type: "sr25519" });
    const account = keyring.addFromUri(config.crustSeeds);

    console.log("[INFO] Fetching CIDs from database...");
    const cidsToMigrate = await getCIDsToMigrate(prisma, progress.migrated);

    if (cidsToMigrate.length === 0) {
      console.log("🎉 No new CIDs to migrate. All done!");
      return;
    }

    console.log(`🧾 Total CIDs to migrate: ${cidsToMigrate.length}`);

    for (const [index, item] of cidsToMigrate.entries()) {
      const { cid, size } = item;
      console.log(
        `\n[${index + 1}/${cidsToMigrate.length}] 🅿️  Processing CID: ${cid}`
      );

      try {
        await placeStorageOrder(api, cid, size, account);
        progress.migrated.push(cid);
        await saveProgress(config.progressFile, progress);
      } catch (err) {
        console.error(`❌ Failed to migrate ${cid}:`, err.message);
      }
    }

    console.log("\n🎉 Migration process completed.");
  } catch (e) {
    console.error("🔥 A fatal error occurred:", e.message);
    process.exit(1);
  } finally {
    console.log("[INFO] Disconnecting from services...");
    await api?.disconnect();
    await prisma.$disconnect();
    console.log("[INFO] Cleanup complete.");
  }
}

// --- Helper Functions ---

async function connectToCrust(endpoint) {
  const provider = new WsProvider(endpoint);
  const api = new ApiPromise({
    provider,
    typesBundle: typesBundleForPolkadot,
  });
  await api.isReadyOrError;
  return api;
}

async function getCIDsToMigrate(prisma, migratedCIDs) {
  const [videos, clips] = await Promise.all([
    prisma.video.findMany({
      where: { ipfs_cid: { not: "null" } },
      select: { ipfs_cid: true },
    }),
    prisma.videoClip.findMany({
      where: { ipfs_cid: { not: "null" } },
      select: { ipfs_cid: true },
    }),
  ]);

  const allItems = [
    ...videos.map((v) => ({
      cid: v.ipfs_cid,
      size: v.file_size || config.defaultFileSize,
    })),
    ...clips.map((c) => ({
      cid: c.ipfs_cid,
      size: c.file_size || config.defaultFileSize,
    })),
  ];

  const uniqueItems = new Map(allItems.map((item) => [item.cid, item]));

  return Array.from(uniqueItems.values()).filter(
    (item) => !migratedCIDs.includes(item.cid)
  );
}

function placeStorageOrder(api, fileCid, fileSize, account) {
  console.log(
    `[INFO] Placing order for CID ${fileCid} with size ${fileSize} bytes.`
  );
  const tips = 0;
  const memo = "";
  const tx = api.tx.market.placeStorageOrder(fileCid, fileSize, tips, memo);

  return new Promise((resolve, reject) => {
    tx.signAndSend(account, ({ events = [], status, dispatchError }) => {
      console.log(`[INFO] Tx Status for ${fileCid}: ${status.type}`);

      if (status.isInBlock || status.isFinalized) {
        if (dispatchError) {
          if (dispatchError.isModule) {
            const decoded = api.registry.findMetaError(dispatchError.asModule);
            const { docs, name, section } = decoded;
            reject(new Error(`[${section}.${name}] ${docs.join(" ")}`));
          } else {
            reject(new Error(dispatchError.toString()));
          }
          return;
        }

        const successEvent = events.find(({ event }) =>
          api.events.system.ExtrinsicSuccess.is(event)
        );

        if (successEvent) {
          const blockHash = status.isInBlock
            ? status.asInBlock
            : status.asFinalized;
          console.log(
            `✅ Order placed successfully for ${fileCid} in block ${blockHash}`
          );
          resolve();
        }
      } else if (status.isError) {
        reject(new Error(`Transaction status error for ${fileCid}`));
      }
    }).catch((err) => {
      reject(err);
    });
  });
}

async function loadProgress(filePath) {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("[INFO] Progress file not found. Starting a new migration.");
      return { migrated: [] };
    }
    throw error;
  }
}

async function saveProgress(filePath, progress) {
  await fs.writeFile(filePath, JSON.stringify(progress, null, 2));
  console.log(
    `[INFO] Progress saved. Total migrated: ${progress.migrated.length}`
  );
}

main().catch(console.error);
