import { describe, it, expect } from "vitest";
import { redactHeaders, redactUrl, redactSecretValues, isSecretHeader } from "open-sse/utils/redactHeaders.js";

const TOKEN = "sk-live-9f2b7c41aa83d0e6";

describe("redactHeaders", () => {
  it("redige os portadores de credencial, qualquer que seja a caixa", () => {
    const out = redactHeaders({
      Authorization: `Bearer ${TOKEN}`,
      "X-Api-Key": TOKEN,
      "x-goog-api-key": TOKEN,
      Cookie: `session=${TOKEN}`,
      "X-Copilot-Token": TOKEN,
    });
    for (const v of Object.values(out)) expect(v).not.toContain(TOKEN);
  });

  it("preserva os headers que não são segredo, para a tela continuar útil", () => {
    const out = redactHeaders({ "Content-Type": "application/json", "Anthropic-Beta": "context-management-2025-06-27", "User-Agent": "claude-cli/2.1" });
    expect(out["Content-Type"]).toBe("application/json");
    expect(out["Anthropic-Beta"]).toBe("context-management-2025-06-27");
    expect(out["User-Agent"]).toBe("claude-cli/2.1");
  });

  it("mantém os NOMES dos headers — é o que a depuração precisa ver", () => {
    const out = redactHeaders({ Authorization: `Bearer ${TOKEN}` });
    expect(Object.keys(out)).toEqual(["Authorization"]);
  });

  it("classifica famílias que variam por provider", () => {
    for (const nome of ["authorization", "x-api-key", "x-goog-api-key", "x-amz-security-token", "proxy-authorization", "cookie", "x-session-token"]) {
      expect(isSecretHeader(nome)).toBe(true);
    }
    for (const nome of ["content-type", "user-agent", "accept", "anthropic-beta"]) {
      expect(isSecretHeader(nome)).toBe(false);
    }
  });
});

describe("redação por valor — nomes de header não bastam", () => {
  it("alcança um header cujo nome não denuncia que é credencial", () => {
    // Kiro manda o bearer em x-amz-sso-bearer; um detector só por nome o ignora.
    const out = redactHeaders({ "x-amz-custom-thing": TOKEN, "Content-Type": "application/json" }, [TOKEN]);
    expect(out["x-amz-custom-thing"]).not.toContain(TOKEN);
    expect(out["Content-Type"]).toBe("application/json");
  });

  it("sem lista de segredos, ainda redige pelos nomes conhecidos", () => {
    const out = redactHeaders({ Authorization: `Bearer ${TOKEN}` });
    expect(out.Authorization).toBe("«redacted»");
  });
});

describe("redactUrl", () => {
  it("remove a chave da query — Vertex manda ?key=<apiKey>", () => {
    const out = redactUrl(`https://api.example.com/v1/models/x:generate?key=${TOKEN}&alt=sse`);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("alt=sse");
  });

  it("remove credencial embutida no host", () => {
    expect(redactUrl(`https://user:${TOKEN}@api.example.com/v1`)).not.toContain(TOKEN);
  });

  it("deixa intacta uma URL sem segredo e não quebra com lixo", () => {
    const limpa = "https://api.example.com/v1/chat?stream=true";
    expect(redactUrl(limpa)).toBe(limpa);
    expect(redactUrl("não é url")).toBe("não é url");
    expect(redactUrl(null)).toBe(null);
  });
});

describe("redactSecretValues", () => {
  it("alcança o token embutido no corpo — Windsurf o põe no payload", () => {
    const body = { model: "x", payload: { auth: TOKEN, msgs: [{ text: `usa ${TOKEN} aqui` }] } };
    const out = redactSecretValues(body, [TOKEN]);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.model).toBe("x");
  });

  it("não mexe no corpo quando não há segredo conhecido", () => {
    const body = { model: "x", messages: [{ role: "user", content: "oi" }] };
    expect(redactSecretValues(body, [])).toEqual(body);
    expect(redactSecretValues(body, [null, undefined, ""])).toEqual(body);
  });

  it("ignora valores curtos demais para serem credencial", () => {
    const body = { texto: "abc def" };
    expect(redactSecretValues(body, ["abc"])).toEqual(body);
  });
});
