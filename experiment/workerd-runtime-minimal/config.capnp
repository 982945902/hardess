using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .demoWorker),
  ],

  sockets = [
    (name = "http", address = "127.0.0.1:6285", http = (), service = "main"),
  ]
);

const demoWorker :Workerd.Worker = (
  modules = [
    (name = "worker", esModule = embed "worker.ts"),
  ],

  bindings = [
    (name = "DEMO_SECRET", text = "hardess-workerd-secret"),
    (name = "RUNTIME_META", json = "{\"runtime\":\"workerd\",\"experiment\":\"minimal-validation\"}"),
  ],

  compatibilityDate = "2025-08-01",
  compatibilityFlags = ["typescript_strip_types"]
);
