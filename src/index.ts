import axios from "axios";
import fastify, { FastifyReply, FastifyRequest } from "fastify";

const app = fastify();

const djangoUrl = "https://api.maiagent.ai/api/v1";

const pendingRequests = new Map<string, FastifyReply>();

function getForwardHeaders(request: FastifyRequest) {
  const headers = { ...request.headers };
  delete headers["content-length"];
  delete headers["host"];
  return headers;
}

// Webhook endpoint
app.post("/webhook", async (request, reply) => {
  const data = request.body as Record<string, any>;

  // Log full request content
  console.log("=".repeat(100));
  console.log("Request:");
  console.log(JSON.stringify(data, null, 4));

  console.log("-".repeat(100));
  // Extract and log the "content" field from the request
  const content = data?.content;
  console.log("Message:");
  console.log(content);
  console.log("=".repeat(100));

  // Find and resolve the pending request
  const conversationId = data?.conversation_id;
  const pendingReply = pendingRequests.get(conversationId);
  if (pendingReply) {
    pendingReply.send(data);
    pendingRequests.delete(conversationId);
  }

  // Respond to the webhook
  reply.status(200);
});

app.post<{ Body: { conversation: string } }>(
  "/messages",
  async (request, reply) => {
    const { body } = request;

    if (!body || !body.conversation) {
      return reply.status(400).send({ error: "conversation is required" });
    }

    const conversationId = body.conversation;
    // Check if there's already a pending request for this conversation
    if (pendingRequests.has(conversationId)) {
      return reply.status(400).send({
        error: "A request for this conversation is already in progress",
      });
    }

    try {
      // Store the reply object to be resolved later
      pendingRequests.set(conversationId, reply);

      // Set a timeout to prevent hanging connections
      const timeout = setTimeout(
        () => {
          if (pendingRequests.has(conversationId)) {
            pendingRequests.delete(conversationId);
            reply.status(504).send({ error: "Request timeout" });
          }
        },
        5 * 60 * 1000,
      ); // 5 minutes timeout

      const forwardUrl = new URL(`${djangoUrl}/messages/`);
      for (const [key, value] of Object.entries(
        request.query as Record<string, string>,
      )) {
        forwardUrl.searchParams.append(key, value);
      }

      // Forward the request with headers and query parameters
      await axios({
        method: "post",
        url: forwardUrl.toString(),
        data: body,
        headers: getForwardHeaders(request),
      });

      // The actual response will be sent when the webhook is received
      request.raw.on("close", () => {
        clearTimeout(timeout);
        pendingRequests.delete(conversationId);
      });

      await reply;
    } catch (error) {
      console.error("Error forwarding request:", error);
      pendingRequests.delete(conversationId);
      reply.status(500).send({
        error: "Request failed",
      });
    }
  },
);

// Start the server
const startServer = async () => {
  try {
    const port = 80;
    await app.listen({ host: "0.0.0.0", port });
    console.log(`Server is running on port ${port}`);
  } catch (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
};

startServer();
