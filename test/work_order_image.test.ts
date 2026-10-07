import assert from "node:assert/strict";
import test from "node:test";
import {
  prepareTechnicianHandoff,
  type ObjectStore,
  type WorkOrder,
} from "../src/work_order_image.js";

test("stores the generated dispatch image before marking it ready for technician review", async () => {
  const events: string[] = [];
  const order: WorkOrder = {
    workOrderId: "WO-42",
    serviceType: "heat pump inspection",
    siteDescription: "residential outdoor unit beside a brick wall",
    technicianNote: "Check debris around the fan guard.",
  };
  const storage: ObjectStore = {
    async ensureBucket(name) {
      events.push(`bucket:${name}`);
    },
    async putBase64(bucket, key, dataBase64) {
      events.push(`put:${bucket}:${key}:${dataBase64}`);
    },
    async presignGet(bucket, key, expiresSeconds) {
      events.push(`presign:${bucket}:${key}:${expiresSeconds}`);
      return "https://private.example/temporary-image";
    },
  };

  const handoff = await prepareTechnicianHandoff(
    order,
    "dispatch-images",
    async (prompt) => {
      assert.match(prompt, /heat pump inspection/);
      events.push("generate");
      return "generated-image-base64";
    },
    storage,
    600,
  );

  assert.deepEqual(events, [
    "bucket:dispatch-images",
    "generate",
    "put:dispatch-images:work-orders/WO-42/dispatch-reference.png:generated-image-base64",
    "presign:dispatch-images:work-orders/WO-42/dispatch-reference.png:600",
  ]);
  assert.deepEqual(handoff, {
    workOrderId: "WO-42",
    status: "ready_for_technician_review",
    imageKey: "work-orders/WO-42/dispatch-reference.png",
    privateImageUrl: "https://private.example/temporary-image",
    expiresInSeconds: 600,
    followUp: "Technician reviews the reference image before accepting the dispatch.",
  });
});
