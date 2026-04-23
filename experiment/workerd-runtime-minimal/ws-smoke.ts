const urlOptionIndex = process.argv.indexOf("--url");
const wsUrl =
  urlOptionIndex >= 0 && process.argv[urlOptionIndex + 1] ? process.argv[urlOptionIndex + 1] : "ws://127.0.0.1:6285/ws";

const ws = new WebSocket(wsUrl);

const result = await new Promise<string>((resolve, reject) => {
  let sawOpenMessage = false;

  const timer = setTimeout(() => {
    try {
      ws.close();
    } catch {
      // ignore close errors during timeout cleanup
    }
    reject(new Error("websocket smoke test timed out"));
  }, 5000);

  ws.addEventListener("open", () => {
    ws.send("hardess-workerd-ws");
  });

  ws.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : String(event.data);
    const payload = JSON.parse(text) as {
      type?: string;
      runtime?: string;
      echo?: string;
      schemaVersion?: string;
    };

    if (payload.type === "open") {
      sawOpenMessage = true;
      return;
    }

    if (!sawOpenMessage) {
      clearTimeout(timer);
      reject(new Error("did not receive websocket open message first"));
      return;
    }

    if (payload.type !== "echo") {
      clearTimeout(timer);
      reject(new Error(`unexpected websocket payload type: ${payload.type}`));
      return;
    }

    if (payload.runtime !== "workerd") {
      clearTimeout(timer);
      reject(new Error(`unexpected websocket runtime: ${payload.runtime}`));
      return;
    }

    if ((payload as { routeId?: string }).routeId !== "route.demo.workerd.ws") {
      clearTimeout(timer);
      reject(new Error(`unexpected websocket routeId: ${(payload as { routeId?: string }).routeId}`));
      return;
    }

    if ((payload as { actionId?: string }).actionId !== "ws.echo") {
      clearTimeout(timer);
      reject(new Error(`unexpected websocket actionId: ${(payload as { actionId?: string }).actionId}`));
      return;
    }

    if (payload.echo !== "hardess-workerd-ws") {
      clearTimeout(timer);
      reject(new Error(`unexpected websocket echo payload: ${payload.echo}`));
      return;
    }

    if (payload.schemaVersion !== "hardess.workerd.worker-action.v1") {
      clearTimeout(timer);
      reject(new Error(`unexpected websocket schemaVersion: ${payload.schemaVersion}`));
      return;
    }

    clearTimeout(timer);
    ws.close(1000, "done");
    resolve(text);
  });

  ws.addEventListener("error", () => {
    clearTimeout(timer);
    reject(new Error("websocket smoke test failed"));
  });
});

console.log(result);
