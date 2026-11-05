import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  configureUpdaterPublicKey,
  injectUpdaterPublicKey,
  validateUpdaterPublicKey,
} from "./configure-updater-public-key.mjs";

const encodedPublicKey = Buffer.from(
  [
    "untrusted comment: minisign public key 0123456789ABCDEF",
    "RWRERERERERERERERERERERERERERERERERERERERERERERERERERE",
    "",
  ].join("\n"),
).toString("base64");

test("validates a Tauri-generated updater public key", () => {
  assert.equal(validateUpdaterPublicKey(encodedPublicKey), encodedPublicKey);
});

test("rejects an empty updater public key", () => {
  assert.throws(
    () => validateUpdaterPublicKey(""),
    /TAURI_UPDATER_PUBLIC_KEY is required/,
  );
});

test("rejects Base64 that is not a Minisign public key", () => {
  const invalid = Buffer.from("RWRERERERERERERERERE\n").toString("base64");
  assert.throws(
    () => validateUpdaterPublicKey(invalid),
    /does not decode to a Minisign public key/,
  );
});

test("injects the updater key without losing existing configuration", () => {
  const config = {
    productName: "Entity Assistant",
    plugins: {
      updater: {
        endpoints: ["https://example.com/latest.json"],
        pubkey: "",
      },
    },
  };

  assert.deepEqual(injectUpdaterPublicKey(config, encodedPublicKey), {
    productName: "Entity Assistant",
    plugins: {
      updater: {
        endpoints: ["https://example.com/latest.json"],
        pubkey: encodedPublicKey,
      },
    },
  });
  assert.equal(config.plugins.updater.pubkey, "");
});

test("writes the updater key into a Tauri configuration file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-agent-desktop-updater-key-"));
  const configPath = join(directory, "tauri.conf.json");

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        plugins: {
          updater: {
            endpoints: ["https://example.com/latest.json"],
            pubkey: "",
          },
        },
      }),
    );

    await configureUpdaterPublicKey({
      publicKey: encodedPublicKey,
      configPath,
    });

    const configured = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(configured.plugins.updater.pubkey, encodedPublicKey);
    assert.deepEqual(configured.plugins.updater.endpoints, [
      "https://example.com/latest.json",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
