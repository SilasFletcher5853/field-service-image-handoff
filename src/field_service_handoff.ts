import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  createInfraiDependencies,
  InfraiError,
  prepareTechnicianHandoff,
} from "./work_order_image.js";

const requestSchema = z.object({
  workOrderId: z.string().trim().min(1).max(80),
  serviceType: z.string().trim().min(1).max(120),
  siteDescription: z.string().trim().min(1).max(500),
  technicianNote: z.string().trim().min(1).max(500),
});

const apiKey = process.env.INFRAI_API_KEY;
if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");

const bucket = process.env.INFRAI_BUCKET ?? "field-service-images";
const { generateImage, storage } = createInfraiDependencies(apiKey);

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function dispatch(body: unknown) {
  const order = requestSchema.parse(body);
  return prepareTechnicianHandoff(order, bucket, generateImage, storage);
}

async function runExample(): Promise<void> {
  const result = await dispatch({
    workOrderId: "WO-2048",
    serviceType: "rooftop HVAC inspection",
    siteDescription: "single-story retail unit with a packaged rooftop air conditioner",
    technicianNote: "Inspect the condenser coils and photograph the access panel before service.",
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv.includes("--example")) {
  await runExample();
} else {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/dispatch-image") {
      sendJson(response, 404, { error: "Route not found" });
      return;
    }

    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      sendJson(response, 201, await dispatch(body));
    } catch (error) {
      if (error instanceof z.ZodError) {
        sendJson(response, 400, { error: "Invalid work order", issues: error.issues });
      } else if (error instanceof SyntaxError) {
        sendJson(response, 400, { error: "Request body must be valid JSON" });
      } else if (error instanceof InfraiError) {
        const status = error.status >= 400 && error.status < 500 ? error.status : 502;
        sendJson(response, status, { error: error.code, details: error.details });
      } else {
        console.error(error);
        sendJson(response, 502, { error: "Image handoff could not be completed" });
      }
    }
  });

  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`Field-service image endpoint listening on http://localhost:${port}`));
}
