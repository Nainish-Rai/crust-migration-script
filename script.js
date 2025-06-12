import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { PrismaClient } from "@prisma/client";
import { ApiPromise, WsProvider } from "@polkadot/api";
import { typesBundleForPolkadot } from "@crustio/type-definitions";
import { Keyring } from "@polkadot/keyring";
import { createHeliaHTTP } from "@helia/http";
import { httpGatewayRouting } from "@helia/routers";
import { unixfs } from "@helia/unixfs";
import { CID } from "multiformats/cid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { CRUST_SEEDS, CRUST_CHAIN_ENDPOINT, IPFS_GATEWAY_URL } = process.env;
const PROCESSED_LOG_FILE = path.join(__dirname, "processed_cids.log");

const prisma = new PrismaClient();

/**
 * Loads processed CIDs from the log file into a Set for efficient lookup.
 * @returns {Set<string>} A set of CIDs that have already been processed.
 */
function loadProcessedCids() {
  try {
    if (fs.existsSync(PROCESSED_LOG_FILE)) {
      const data = fs.readFileSync(PROCESSED_LOG_FILE, "utf-8");
      const cids = data.split("\n").filter((line) => line.trim() !== "");
      console.log(`Loaded ${cids.length} processed CIDs from log file.`);
      return new Set(cids);
    }
  } catch (error) {
    console.error("Could not read processed CIDs log file.", error);
    // On error, return an empty set to be safe
  }
  console.log("No existing log file found. Starting fresh.");
  return new Set();
}

/**
 * Appends a successfully processed CID to the log file.
 * @param {string} cid - The CID to log.
 */
function logProcessedCid(cid) {
  try {
    fs.appendFileSync(PROCESSED_LOG_FILE, `${cid}\n`);
  } catch (error) {
    console.error(`FATAL: Could not write CID ${cid} to log file!`, error);
  }
}

/**
 * Validates if a string is a valid IPFS CID
 * @param {string} cidString - The CID string to validate
 * @returns {boolean} - True if valid CID, false otherwise
 */
function isValidCID(cidString) {
  try {
    CID.parse(cidString);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Gets file statistics using Helia
 * @param {*} fs - The Helia UnixFS instance
 * @param {string} cid - The IPFS CID
 * @returns {Promise<{size: number}>} - File statistics
 */
async function getFileStats(fs, cid) {
  try {
    const cidObj = CID.parse(cid);
    const stat = await fs.stat(cidObj);
    return { size: stat.fileSize || stat.cumulativeSize || 0 };
  } catch (error) {
    throw new Error(
      `Failed to get file stats for CID ${cid}: ${error.message}`
    );
  }
}

/**
 * Places a storage order on the Crust Network.
 * @param {ApiPromise} api - The Polkadot API instance.
 * @param {string} fileCid - The IPFS CID of the file.
 * @param {number} fileSize - The size of the file in bytes.
 * @returns {Promise<boolean>} - A promise that resolves to true on success.
 */
async function placeCrustOrder(api, fileCid, fileSize) {
  const kr = new Keyring({ type: "sr25519" });
  const krp = kr.addFromUri(CRUST_SEEDS);

  const tx = api.tx.market.placeStorageOrder(fileCid, fileSize, 0, "");

  console.log(
    `   Placing storage order for CID: ${fileCid} with size: ${fileSize} bytes...`
  );

  return new Promise((resolve, reject) => {
    tx.signAndSend(krp, ({ events = [], status }) => {
      console.log(`   Transaction status: ${status.type}`);

      if (status.isInBlock) {
        events.forEach(({ event: { method } }) => {
          if (method === "ExtrinsicSuccess") {
            console.log(
              `✅  Successfully placed storage order for CID: ${fileCid}`
            );
            resolve(true);
          } else if (method === "ExtrinsicFailed") {
            console.error(
              `❌  Failed to place storage order for CID: ${fileCid}`
            );
            reject(new Error("ExtrinsicFailed"));
          }
        });
      }
    }).catch((e) => {
      console.error(`   Error sending transaction for CID ${fileCid}:`, e);
      reject(e);
    });
  });
}

/**
 * Main migration function
 */
async function main() {
  console.log(
    "--- Starting Crust Storage Migration Script (Read-Only Mode) ---"
  );

  if (!CRUST_SEEDS || !CRUST_CHAIN_ENDPOINT || !IPFS_GATEWAY_URL) {
    throw new Error(
      "Please define CRUST_SEEDS, CRUST_CHAIN_ENDPOINT, and IPFS_GATEWAY_URL in your .env file."
    );
  }

  const processedCids = loadProcessedCids();

  // --- INITIALIZE APIs ---
  const api = new ApiPromise({
    provider: new WsProvider(
      "wss://api-crust-mainnet.n.dwellir.com/1791deb9-183c-4d92-9c70-a9fba633bee4"
    ),
    typesBundle: typesBundleForPolkadot,
  });

  console.log("Initializing Helia IPFS client...");
  const helia = await createHeliaHTTP({
    routers: [
      httpGatewayRouting({
        gateways: [IPFS_GATEWAY_URL],
      }),
    ],
  });
  const heliaFs = unixfs(helia);

  await api.isReadyOrError;
  console.log("Crust API and Helia IPFS client are ready.");

  // --- FETCH ALL CIDs FROM DATABASE ---
  console.log("\nFetching all records with CIDs from the database...");
  const videos = await prisma.video.findMany({
    where: { ipfs_cid: { not: null, not: "" } },
    select: { video_id: true, ipfs_cid: true },
  });
  const clips = await prisma.videoClip.findMany({
    where: { ipfs_cid: { not: null, not: "" } },
    select: { clip_id: true, ipfs_cid: true },
  });

  const allItems = [
    ...videos.map((v) => ({ id: v.video_id, cid: v.ipfs_cid, type: "Video" })),
    ...clips.map((c) => ({
      id: c.clip_id,
      cid: c.ipfs_cid,
      type: "VideoClip",
    })),
  ];

  // Filter out invalid CIDs (like "MIGRATED" or other non-CID values)
  const validItems = allItems.filter((item) => {
    if (!isValidCID(item.cid)) {
      console.log(
        `⚠️  Skipping invalid CID: "${item.cid}" for ${item.type} ID: ${item.id}`
      );
      return false;
    }
    return true;
  });

  console.log(
    `Found ${allItems.length} total records with CIDs, ${validItems.length} have valid CIDs.`
  );

  // Deduplicate CIDs as the same file might be referenced multiple times
  const uniqueCids = [
    ...new Map(validItems.map((item) => [item.cid, item])).values(),
  ];

  console.log(`Corresponding to ${uniqueCids.length} unique valid CIDs.`);

  // --- FILTER OUT ALREADY PROCESSED CIDs ---
  const itemsToProcess = uniqueCids.filter(
    (item) => !processedCids.has(item.cid)
  );

  console.log(`${itemsToProcess.length} new CIDs to process.`);
  if (itemsToProcess.length === 0) {
    console.log("No new records to process. Exiting.");
    await helia.stop();
    return;
  }

  // --- PROCESS NEW CIDs ---
  for (const item of itemsToProcess) {
    const { id, cid, type } = item;
    console.log(`\nProcessing ${type} record (ID: ${id}) with new CID: ${cid}`);

    try {
      // 1. Get file size from IPFS using Helia
      console.log("   Querying IPFS for file stats...");
      const fileStat = await getFileStats(heliaFs, cid);
      const fileSize = fileStat.size;

      if (!fileSize || fileSize === 0) {
        throw new Error(
          "Could not retrieve a valid file size from IPFS. Skipping."
        );
      }

      // 2. Place storage order on Crust
      await placeCrustOrder(api, cid, fileSize);

      // 3. Log the CID to our local file on success
      logProcessedCid(cid);
      console.log(`   Logged CID ${cid} to ${PROCESSED_LOG_FILE}.`);
    } catch (error) {
      console.error(`❌ FAILED to process CID ${cid}: ${error.message}`);
      console.log(`   CID ${cid} will be retried on the next run.`);
    }
  }

  console.log("\n--- Migration Script Finished ---");
  await helia.stop();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
