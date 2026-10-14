// The en-GB message catalog, one JSON file per feature namespace.
// Adding a namespace: create `<namespace>.json` here and register it below.
import auth from "./auth.json";
import common from "./common.json";
import dashboard from "./dashboard.json";
import errors from "./errors.json";
import layout from "./layout.json";
import metadata from "./metadata.json";
import nav from "./nav.json";
import validation from "./validation.json";

const messages = {
  auth,
  common,
  dashboard,
  errors,
  layout,
  metadata,
  nav,
  validation,
};

export default messages;
