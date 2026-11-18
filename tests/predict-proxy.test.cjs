const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

async function exerciseRoute(relativePath) {
  const router = require(path.join(projectRoot, relativePath));
  const handler = router.stack[0].route.stack[0].handle;
  let forwarded = 0;

  global.fetch = async () => {
    forwarded += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ prediction: "TEST", confidence: 1 })
    };
  };

  function mockResponse() {
    return {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };
  }

  const shortResponse = mockResponse();
  await handler({ body: { frames: Array(59).fill({}) } }, shortResponse);
  assert.equal(shortResponse.statusCode, 400, `${relativePath} rejects 59 frames`);
  assert.equal(forwarded, 0, `${relativePath} does not forward invalid input`);

  const validResponse = mockResponse();
  await handler({ body: { frames: Array(60).fill({}) } }, validResponse);
  assert.equal(validResponse.statusCode, 200, `${relativePath} accepts 60 frames`);
  assert.equal(forwarded, 1, `${relativePath} forwards valid input once`);
  assert.equal(validResponse.body.prediction, "TEST");
}

test("both prediction proxies enforce the 60-frame LSTM contract", async () => {
  await exerciseRoute("api/_lib/predictRoutes.js");
  await exerciseRoute("server/routes/predict.js");
});
