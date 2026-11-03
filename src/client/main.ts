import "./style.css";
import { api, type Me } from "./api";
import { clear, h, toast } from "./dom";
import { mountGame } from "./game";
import { mountAdmin } from "./admin";

const root = document.getElementById("app")!;

async function boot() {
  try { showGame(await api.me()); }
  catch { showLogin(); }
}

function showGame(me: Me) {
  history.replaceState(null, "", location.pathname === "/admin" ? "/" : location.pathname);
  mountGame(root, {
    me,
    onAdmin: () => { history.pushState(null, "", "/admin"); void mountAdmin(root, () => showGame(me)); },
    onLogout: async () => { await api.logout().catch(() => {}); showLogin(); },
  });
}

async function showLogin() {
  const cfg = await api.config().catch(() => ({ title: "9Hells", allowRegistration: false }));
  let mode: "login" | "register" = "login";
  const err = h("p.form-error", { role: "alert" });
  const user = h("input", { name: "username", autocomplete: "username", required: true, minlength: 3, maxlength: 32 }) as HTMLInputElement;
  const pass = h("input", { name: "password", type: "password", autocomplete: "current-password", required: true, minlength: 6 }) as HTMLInputElement;
  const submit = h("button.primary", { type: "submit" }, "Log in");
  const swap = h("button.linkish", { type: "button" }, "Create an account");
  const heading = h("h2", {}, "Log in to continue the climb");

  swap.addEventListener("click", () => {
    mode = mode === "login" ? "register" : "login";
    submit.textContent = mode === "login" ? "Log in" : "Create account";
    swap.textContent = mode === "login" ? "Create an account" : "I already have an account";
    heading.textContent = mode === "login" ? "Log in to continue the climb" : "Create an account";
    pass.autocomplete = mode === "login" ? "current-password" : "new-password";
    err.textContent = "";
  });

  const form = h("form.login", {
    onSubmit: async (ev: Event) => {
      ev.preventDefault();
      err.textContent = "";
      try {
        const me = mode === "login" ? await api.login(user.value, pass.value) : await api.register(user.value, pass.value);
        showGame(me);
      } catch (e: any) { err.textContent = e.message; }
    },
  },
    heading,
    h("label", {}, "Username", user),
    h("label", {}, "Password", pass),
    err,
    submit,
    cfg.allowRegistration ? swap : null,
  );

  clear(root);
  root.append(h("div.gate", {},
    h("div.gate-title", {}, h("h1.wordmark.big", {}, cfg.title || "9Hells"), h("p", {}, "Nine layers of Hell. Four companions. One way out.")),
    form));
  user.focus();
}

window.addEventListener("unhandledrejection", (e) => toast(String(e.reason?.message ?? e.reason), "error"));
void boot();
