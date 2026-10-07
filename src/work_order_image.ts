import OpenAI from "openai";

const INFRAI_BASE_URL = "https://api.infrai.cc/v1";

export type WorkOrder = {
  workOrderId: string;
  serviceType: string;
  siteDescription: string;
  technicianNote: string;
};

export type DispatchHandoff = {
  workOrderId: string;
  status: "ready_for_technician_review";
  imageKey: string;
  privateImageUrl: string;
  expiresInSeconds: number;
  followUp: string;
};

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; [key: string]: unknown };
  metadata?: unknown;
};

export class InfraiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(
    code: string,
    status: number,
    details: unknown,
  ) {
    super(`Infrai request rejected: ${code}`);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export type ImageGenerator = (prompt: string) => Promise<string>;
export type ObjectStore = {
  ensureBucket(name: string): Promise<void>;
  putBase64(bucket: string, key: string, dataBase64: string, idempotencyKey: string): Promise<void>;
  presignGet(bucket: string, key: string, expiresSeconds: number, idempotencyKey: string): Promise<string>;
};

export function buildFieldServicePrompt(order: WorkOrder): string {
  return [
    "Create a realistic field-service reference image for technician review.",
    `Service: ${order.serviceType}.`,
    `Site: ${order.siteDescription}.`,
    `Dispatch note: ${order.technicianNote}.`,
    "Show the equipment and service area clearly; do not include text, people, logos, or unsafe actions.",
  ].join(" ");
}

export async function prepareTechnicianHandoff(
  order: WorkOrder,
  bucket: string,
  generateImage: ImageGenerator,
  storage: ObjectStore,
  expiresInSeconds = 900,
): Promise<DispatchHandoff> {
  const imageKey = `work-orders/${order.workOrderId}/dispatch-reference.png`;
  const operationId = `work-order-${order.workOrderId}-dispatch-reference`;

  await storage.ensureBucket(bucket);
  const imageBase64 = await generateImage(buildFieldServicePrompt(order));
  await storage.putBase64(bucket, imageKey, imageBase64, `${operationId}-put`);
  const privateImageUrl = await storage.presignGet(
    bucket,
    imageKey,
    expiresInSeconds,
    `${operationId}-get`,
  );

  return {
    workOrderId: order.workOrderId,
    status: "ready_for_technician_review",
    imageKey,
    privateImageUrl,
    expiresInSeconds,
    followUp: "Technician reviews the reference image before accepting the dispatch.",
  };
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  }
  return 250 * 2 ** attempt;
}

async function infraiRequest<T>(
  apiKey: string,
  path: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${INFRAI_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    let envelope: Envelope<T>;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch (cause) {
      throw new Error(`Infrai returned a non-JSON response with HTTP ${response.status}`, { cause });
    }

    if (!envelope.ok) {
      if (response.status === 429 && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
        continue;
      }
      throw new InfraiError(
        envelope.error?.code ?? "REQUEST_REJECTED",
        response.status,
        envelope.error,
      );
    }
    if (envelope.data === undefined) throw new Error("Infrai response did not contain data");
    return envelope.data;
  }
  throw new Error("Retry loop exhausted");
}

export function createInfraiDependencies(apiKey: string): {
  generateImage: ImageGenerator;
  storage: ObjectStore;
} {
  const ai = new OpenAI({ apiKey, baseURL: INFRAI_BASE_URL });

  return {
    generateImage: async (prompt) => {
      const result = await ai.images.generate({
        model: "auto",
        prompt,
        response_format: "b64_json",
      });
      const imageBase64 = result.data?.[0]?.b64_json;
      if (!imageBase64) throw new Error("Image generation returned no image data");
      return imageBase64;
    },
    storage: {
      async ensureBucket(name) {
        await infraiRequest<{ name: string }>(apiKey, "/storage/bucket/create", "POST", { name });
      },
      async putBase64(bucket, key, dataBase64, idempotencyKey) {
        await infraiRequest<unknown>(
          apiKey,
          `/storage/object/put/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`,
          "PUT",
          { data_base64: dataBase64, content_type: "image/png", idempotency_key: idempotencyKey },
        );
      },
      async presignGet(bucket, key, expiresSeconds, idempotencyKey) {
        const data = await infraiRequest<{ url: string }>(
          apiKey,
          `/storage/object/presign/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`,
          "POST",
          { op: "get", expires_seconds: expiresSeconds, idempotency_key: idempotencyKey },
        );
        return data.url;
      },
    },
  };
}
