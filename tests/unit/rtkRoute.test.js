import { describe, it, expect } from "vitest";
import { routeBlock } from "open-sse/rtk/route.js";

const gitDiff = "diff --git a/x b/x\n@@ -1,3 +1,4 @@\n+linha\n-linha\n".repeat(40);
const grep = Array.from({ length: 80 }, (_, i) => `src/a.js:${i}:match`).join("\n");
const json = JSON.stringify({ data: Array.from({ length: 900 }, (_, i) => ({ id: i, nome: "item " + i, d: "x".repeat(40) })) });
const prosa = "Este é um parágrafo de documentação explicando um conceito importante do sistema. ".repeat(400);
const html = "<html><body>" + "<div class='c'><p>texto aqui</p></div>".repeat(900) + "</body></html>";
const logs = Array.from({ length: 200 }, (_, i) => `[2026-09-16] evento ${i % 20} concluido`).join("\n");

const BOTH = { rtkEnabled: true, headroomEnabled: true };
const SO_RTK = { rtkEnabled: true, headroomEnabled: false };

describe("routeBlock — cada compressor no que é bom", () => {
  it("manda saída estruturada para o RTK, mesmo com Headroom ligado", () => {
    expect(routeBlock(gitDiff, BOTH)).toBe("rtk");
    expect(routeBlock(grep, BOTH)).toBe("rtk");
  });

  it("manda texto sem estrutura para o Headroom, que o lê semanticamente", () => {
    expect(routeBlock(json, BOTH)).toBe("headroom");
    expect(routeBlock(prosa, BOTH)).toBe("headroom");
    expect(routeBlock(html, BOTH)).toBe("headroom");
  });

  it("sem Headroom, o RTK fica com tudo — nada deixa de ser comprimido", () => {
    for (const texto of [json, prosa, html, logs]) {
      expect(routeBlock(texto, SO_RTK)).toBe("rtk");
    }
  });

  it("os genéricos do RTK cedem ao Headroom quando ele existe", () => {
    // dedup-log/smart-truncate são heurísticas de última instância, não estrutura
    // real: com Headroom disponível, ele lê esse texto melhor.
    expect(routeBlock(logs, SO_RTK)).toBe("rtk");
    const grande = "Mensagem de log sem repetição suficiente para dedup, número " +
      Array.from({ length: 300 }, (_, i) => `${i} com bastante texto corrido aqui`).join(". ");
    expect(routeBlock(grande, BOTH)).toBe("headroom");
  });

  it("estrutura fica com o RTK mesmo quando o Headroom está ligado (não é tudo dele)", () => {
    // Precisa ser estrutura GRANDE: abaixo do limiar semântico todo bloco cairia
    // no RTK de qualquer modo, e trocar a regra por "sempre headroom" passaria
    // despercebido. Estes casos são grandes e semanticamente ambíguos de propósito.
    const diffGrande = "diff --git a/src/app.js b/src/app.js\n@@ -1,50 +1,60 @@\n" +
      Array.from({ length: 900 }, (_, i) => `+  const resultado${i} = calcular(valor, ${i}); // comentário explicativo aqui.`).join("\n");
    const grepGrande = Array.from({ length: 900 },
      (_, i) => `src/modulo/arquivo${i}.js:${i}:  função que faz algo relevante no sistema. Detalhe extra.`).join("\n");

    expect(diffGrande.length).toBeGreaterThan(4 * 1024);
    expect(grepGrande.length).toBeGreaterThan(4 * 1024);
    expect(routeBlock(diffGrande, BOTH)).toBe("rtk");
    expect(routeBlock(grepGrande, BOTH)).toBe("rtk");
    expect(routeBlock(diffGrande, SO_RTK)).toBe("rtk");

    // O caso decisivo: estrutura cujas linhas são longas e pontuadas, portanto
    // indistinguível de prosa pelo teste de forma. Só a precedência do filtro
    // estruturado a mantém no RTK — sem ela, iria para o Headroom e perderíamos
    // a reescrita que preserva os caminhos de arquivo.
    const grepProsa = Array.from({ length: 200 }, (_, i) =>
      `src/modulo/arquivo${i}.js:${i}:  ` +
      "Este trecho documenta o comportamento esperado do sistema em detalhe. ".repeat(3)
    ).join("\n");
    expect(grepProsa.length).toBeGreaterThan(4 * 1024);
    expect(routeBlock(grepProsa, BOTH)).toBe("rtk");
  });

  it("blocos pequenos não passam por compressor nenhum", () => {
    expect(routeBlock("ok", BOTH)).toBe("none");
    expect(routeBlock("", BOTH)).toBe("none");
    expect(routeBlock(null, BOTH)).toBe("none");
  });

  it("com o RTK desligado, estrutura ainda pode ir para o Headroom", () => {
    expect(routeBlock(json, { rtkEnabled: false, headroomEnabled: true })).toBe("headroom");
    expect(routeBlock(json, { rtkEnabled: false, headroomEnabled: false })).toBe("none");
  });
});

describe("smartTruncate cobre blob de linha única", () => {
  it("corta por bytes o que o critério de linhas nunca alcança", async () => {
    const { smartTruncate } = await import("open-sse/rtk/filters/smartTruncate.js");
    // Minified JSON: 1 linha, centenas de KB — o gate de 250 linhas jamais dispara.
    const uma = JSON.stringify({ d: Array.from({ length: 3000 }, (_, i) => ({ i, t: "x".repeat(40) })) });
    expect(uma.split("\n").length).toBe(1);
    const out = smartTruncate(uma);
    expect(out.length).toBeLessThan(uma.length / 2);
    expect(out).toContain("characters truncated");
  });

  it("deixa intacto o que é pequeno demais para valer o corte", async () => {
    const { smartTruncate } = await import("open-sse/rtk/filters/smartTruncate.js");
    const pequeno = JSON.stringify({ ok: true, itens: [1, 2, 3] });
    expect(smartTruncate(pequeno)).toBe(pequeno);
  });

  it("mantém o comportamento por linhas de antes", async () => {
    const { smartTruncate } = await import("open-sse/rtk/filters/smartTruncate.js");
    const muitas = Array.from({ length: 400 }, (_, i) => `linha ${i}`).join("\n");
    const out = smartTruncate(muitas);
    expect(out).toContain("lines truncated");
    expect(out.split("\n").length).toBeLessThan(400);
  });
});

describe("coordenação nunca piora o payload", () => {
  const corpo = () => ({ messages: [
    { role: "user", content: [{ type: "text", text: "tarefa" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1",
      content: JSON.stringify({ d: Array.from({ length: 900 }, (_, i) => ({ id: i, n: "item " + i, x: "y".repeat(50) })) }) }] },
  ]});
  const bytes = (o) => Buffer.byteLength(JSON.stringify(o));

  it("cede o bloco ao Headroom quando ele está ligado", async () => {
    const { compressMessages } = await import("open-sse/rtk/index.js");
    const b = corpo();
    const antes = bytes(b);
    const stats = compressMessages(b, true, { headroomEnabled: true });
    expect(stats.deferred).toBeGreaterThan(0);
    expect(bytes(b)).toBe(antes); // intocado — é do Headroom agora
  });

  it("se o Headroom não entrega, o bloco adiado ainda é comprimido", async () => {
    const { compressMessages, compressDeferred } = await import("open-sse/rtk/index.js");
    const b = corpo();
    const antes = bytes(b);
    compressMessages(b, true, { headroomEnabled: true });
    // Headroom devolveu null (timeout / proxy fora): recupera.
    const rec = compressDeferred(b, true);
    expect(rec.hits.length).toBeGreaterThan(0);
    expect(bytes(b)).toBeLessThan(antes / 2);
  });
});
