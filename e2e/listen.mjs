// End-to-end check of the meeting coach in a real Chrome (run in CI).
// Usage: node e2e/listen.mjs <app.html or https URL> <audio dir>
// Speech recognition is real; the Claude API is answered by a local stand-in.
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { chromium } from "playwright"

const target = process.argv[2]
const remote = /^https?:\/\//.test(target)
const appUrl = remote ? target : `file://${path.resolve(target)}`
const audioDir = path.resolve(process.argv[3])
const channel = process.env.BROWSER_CHANNEL ?? "chrome"
// On CI a virtual PulseAudio microphone plays whatever clip MIC_CONTROL names:
// speech recognition reads the system microphone, not Chrome's fake device.
const micControl = process.env.MIC_CONTROL
let failures = 0

function report(name, ok, info) {
  if (!ok) failures += 1
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${info === undefined ? "" : ` | ${JSON.stringify(info)}`}`)
}

const server = http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost")
    if (url.pathname.startsWith("/audio/")) {
      res.setHeader("content-type", "audio/wav")
      res.setHeader("access-control-allow-origin", "*")
      fs.createReadStream(path.join(audioDir, path.basename(url.pathname))).pipe(res)
    } else if (url.pathname === "/blank") {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end("<!doctype html><title>probe</title>")
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  .listen(5199)

function launch(micClip) {
  if (micControl) fs.writeFileSync(micControl, path.join(audioDir, micClip))
  const fakeMic = micControl
    ? []
    : ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${path.join(audioDir, micClip)}`]
  return chromium.launch({
    channel: channel || undefined,
    headless: process.env.HEADLESS === "1",
    args: ["--use-fake-ui-for-media-stream", ...fakeMic, "--autoplay-policy=no-user-gesture-required"],
  })
}

async function screenshot(page, name) {
  const data = (await page.screenshot({ type: "jpeg", quality: 35 })).toString("base64")
  for (let index = 0; index < data.length; index += 3000) {
    console.log(`SHOT|${name}|${index / 3000}|${data.slice(index, index + 3000)}`)
  }
  console.log(`SHOT|${name}|end`)
}

async function waitFor(page, predicate, timeout) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await predicate()
    if (value) return value
    await page.waitForTimeout(500)
  }
  return null
}

async function rawProbe(url) {
  const browser = await launch("her.wav")
  const page = await browser.newPage()
  await page.goto(url)
  const result = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
        if (!Recognition) return resolve({ api: false })
        const out = { api: true, events: [], finals: [] }
        const recognition = new Recognition()
        recognition.lang = "pt-BR"
        recognition.continuous = true
        recognition.interimResults = true
        recognition.onstart = () => out.events.push("start")
        recognition.onerror = (event) => out.events.push(`error:${event.error}`)
        recognition.onend = () => out.events.push("end")
        recognition.onresult = (event) => {
          for (let index = event.resultIndex; index < event.results.length; index += 1) {
            if (event.results[index].isFinal) out.finals.push(event.results[index][0].transcript)
          }
        }
        recognition.start()
        setTimeout(() => {
          try {
            recognition.stop()
          } catch {}
          setTimeout(() => resolve(out), 1500)
        }, 20000)
      }),
  )
  await browser.close()
  return result
}

// The browser's tab picker cannot be automated, and with fake devices Chrome
// hands the microphone back as the "shared tab". Stand in for the shared
// meeting tab with its own, independent audio clip.
async function shareMeetingClip(page, clip) {
  let clipUrl = `http://localhost:5199/audio/${clip}`
  if (remote) {
    const origin = new URL(appUrl).origin
    clipUrl = `${origin}/__test-audio/${clip}`
    await page.route(`${origin}/__test-audio/*`, (route) =>
      route.fulfill({ path: path.join(audioDir, clip), contentType: "audio/wav" }),
    )
  }
  await page.addInitScript((url) => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const context = new AudioContext()
      const response = await fetch(url)
      const buffer = await context.decodeAudioData(await response.arrayBuffer())
      const source = context.createBufferSource()
      source.buffer = buffer
      source.loop = true
      const destination = context.createMediaStreamDestination()
      source.connect(destination)
      source.start()
      await context.resume()
      return destination.stream
    }
  }, clipUrl)
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "POST, OPTIONS",
}

function message(payload, model) {
  return {
    id: "msg_e2e",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: JSON.stringify(payload) }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  }
}

function sse(payload, model) {
  const text = JSON.stringify(payload)
  const events = [
    ["message_start", { type: "message_start", message: { ...message({}, model), content: [], stop_reason: null } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 80 } }],
    ["message_stop", { type: "message_stop" }],
  ]
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join("")
}

// Stands in for api.anthropic.com: answers by request type and records what the page sent.
async function fakeClaude(page) {
  const requests = []
  await page.route("https://api.anthropic.com/**", async (route) => {
    const request = route.request()
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS })
    const body = JSON.parse(request.postData() || "{}")
    const schema = JSON.stringify(body.output_config?.format ?? {})
    const content = String(body.messages?.[0]?.content ?? "")
    const headers = request.headers()
    requests.push({ schema, content, model: body.model, fallbacks: body.fallbacks, beta: headers["anthropic-beta"], key: headers["x-api-key"] })
    if (schema.includes("entendimento")) {
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": "application/json" },
        body: JSON.stringify(
          message(
            {
              titulo: "Piloto de onboarding",
              objetivo: "Aprovar um piloto de 30 dias",
              participantes: [{ nome: "Marcos", papel: "Diretor comercial", observacoes: "Receio com tempo de venda" }],
              pontos: ["Piloto de 30 dias", "Medir a conversão"],
              cuidados: ["Não prometer resultado de vendas"],
              entendimento: "Você vai pedir ao Marcos a aprovação de um piloto de 30 dias.",
            },
            body.model,
          ),
        ),
      })
    }
    if (schema.includes("resumo")) {
      return route.fulfill({
        status: 200,
        headers: { ...CORS, "content-type": "text/event-stream" },
        body: sse(
          {
            resumo: "O Marcos pediu para desenvolver a análise de dados.",
            decisoes: ["Começar pela análise de dados"],
            acoes: [{ responsavel: "Você", tarefa: "Trazer indicadores", prazo: "próxima reunião" }],
            proximos_passos: ["Rever os indicadores"],
            pendencias: [],
            pontos_nao_falados: ["Piloto de 30 dias"],
          },
          body.model,
        ),
      })
    }
    const heardThem = /Outros: .*desenvolver/i.test(content)
    const heardMe = /Você: .*exemplo concreto/i.test(content)
    const payload = heardThem
      ? {
          status: "APROFUNDAR",
          leitura: "Pediram para desenvolver algo; torne isso concreto.",
          fala: "Que indicador vocês usariam para dizer que melhorou?",
          ponto_id: "p2",
          pontos_cobertos: [],
        }
      : heardMe
        ? { status: "OUVIR", leitura: "Você perguntou; agora escute a resposta.", fala: "", ponto_id: "", pontos_cobertos: [] }
        : { status: "OUVIR", leitura: "Ainda cedo; escute.", fala: "", ponto_id: "", pontos_cobertos: [] }
    return route.fulfill({
      status: 200,
      headers: { ...CORS, "content-type": "application/json" },
      body: JSON.stringify(message(payload, body.model)),
    })
  })
  return requests
}

async function card(page) {
  return page.evaluate(() => ({
    status: document.querySelector("[data-testid=coach-status]")?.textContent ?? "",
    reading: document.querySelector("[data-testid=coach-reading]")?.textContent ?? "",
    line: document.querySelector("[data-testid=coach-line]")?.textContent ?? "",
  }))
}

async function transcript(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("li")].map((node) => node.textContent).filter((text) => /^(Você|Outros):/.test(text ?? "")),
  )
}

async function activeSpeaker(page) {
  return page.evaluate(
    () =>
      [...document.querySelectorAll("button[aria-pressed=true]")]
        .map((node) => node.textContent ?? "")
        .find((text) => /Eu falo|Outros falam/i.test(text)) ?? null,
  )
}

async function panelStatus(page) {
  return page.evaluate(() =>
    document.body.innerText
      .split("\n")
      .filter((line) => /transcri|Microfone|microfone|Ouvindo|serviço de voz|Ativando|API|IA/.test(line))
      .slice(0, 6),
  )
}

const BRIEFING =
  "Reunião com o Marcos, diretor comercial, sobre o piloto do onboarding. Meu objetivo é aprovar 30 dias. " +
  "Quero falar da medição de conversão. Evitar prometer resultado de vendas."

async function prepareAndStart(page, mode, label) {
  await page.waitForSelector("#briefing", { timeout: 15000 })
  await page.fill("#briefing", BRIEFING)
  await page.fill("#api-key", "sk-ant-e2e-test")
  await page.check("#consent")
  await page.click(`text=${mode}`)
  await page.click("text=Preparar reunião")
  const understood = await waitFor(page, async () => (await page.locator("[data-testid=understanding]").count()) > 0, 15000)
  report(`${label}: a IA devolve o entendimento do roteiro`, Boolean(understood), understood ? undefined : await panelStatus(page))
  await page.click("text=Começar reunião")
}

async function main() {
  for (const [name, url] of [
    ["arquivo local (file://)", `file://${path.join(os.tmpdir(), "probe.html")}`],
    ["site (http://localhost)", "http://localhost:5199/blank"],
  ]) {
    fs.writeFileSync(path.join(os.tmpdir(), "probe.html"), "<!doctype html><meta charset=utf-8><title>probe</title>")
    const result = await rawProbe(url)
    report(`${channel || "chromium"}: reconhecimento de voz direto, ${name}`, result.finals.length > 0, result)
  }
  if (process.env.PROBE_ONLY === "1") return

  // 1. In person: the user marks turns; the AI reacts to what the others said; summary at the end.
  {
    const browser = await launch("her.wav")
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    const errors = []
    page.on("pageerror", (error) => errors.push(String(error)))
    const requests = await fakeClaude(page)
    await page.goto(appUrl)
    await page.waitForSelector("#briefing", { timeout: 15000 })
    await page.click("text=Testar escuta")
    const heard = await waitFor(
      page,
      async () =>
        (await page.locator("text=Funcionou: o app está ouvindo.").count()) > 0 &&
        (await page.locator("[data-testid=listen-test-heard]").innerText()),
      30000,
    )
    report("Testar escuta mostra a frase ouvida", Boolean(heard), heard || (await panelStatus(page)))
    await page.click("text=Parar teste")

    await prepareAndStart(page, "Presencial (ou aplicativo instalado)", "Presencial")
    await page.waitForTimeout(800)
    await page.keyboard.press("2")
    const lines = await waitFor(page, async () => {
      const found = await transcript(page)
      return found.some((text) => text.startsWith("Outros:")) ? found : null
    }, 40000)
    report("Presencial: transcreve a fala dos outros", Boolean(lines), lines ?? { panel: await panelStatus(page) })
    const asked = await waitFor(page, async () => requests.find((entry) => /Outros: .*desenvolver/i.test(entry.content)), 30000)
    report(
      "Presencial: envia à IA o roteiro, a transcrição e a chave",
      Boolean(asked) && asked.key === "sk-ant-e2e-test" && asked.fallbacks === "default" && /server-side-fallback/.test(asked.beta ?? ""),
      asked ? { model: asked.model, beta: asked.beta } : requests.length,
    )
    const guidance = await waitFor(page, async () => {
      const value = await card(page)
      return value.status === "APROFUNDAR" ? value : null
    }, 20000)
    report("Presencial: mostra a sugestão da IA no cartão", Boolean(guidance), guidance ?? (await card(page)))
    await screenshot(page, "presencial")

    await page.click("text=Encerrar")
    await page.click("text=Confirmar encerramento")
    const summary = await waitFor(page, async () => {
      const count = await page.locator("[data-testid=summary]").count()
      return count > 0 ? await page.locator("[data-testid=summary]").innerText() : null
    }, 20000)
    report("Resumo: a IA gera o resumo ao encerrar", Boolean(summary) && /Trazer indicadores/.test(await page.content()), summary?.slice(0, 160))
    report("Presencial: sem erros na página", errors.length === 0, errors)
    await screenshot(page, "resumo")
    await browser.close()
  }

  // 2. Online, the others speak: the meeting audio plays their voice (the mic hears it too, like speakers).
  {
    const browser = await launch("her.wav")
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    const errors = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await fakeClaude(page)
    await shareMeetingClip(page, "her.wav")
    await page.goto(appUrl)
    await prepareAndStart(page, "Reunião online pelo navegador", "Online")
    await page.click("text=Conectar áudio da reunião")
    const connected = await waitFor(page, async () => (await page.locator("text=Ouvindo a reunião").count()) > 0, 15000)
    report("Online: conecta o áudio da reunião", Boolean(connected))
    const speaker = await waitFor(page, async () => {
      const value = await activeSpeaker(page)
      return value && /Outros/i.test(value) ? value : null
    }, 15000)
    report("Online: detecta sozinho que os OUTROS estão falando", Boolean(speaker), speaker ?? (await activeSpeaker(page)))
    const lines = await waitFor(page, async () => {
      const found = await transcript(page)
      return found.some((text) => text.startsWith("Outros:")) ? found : null
    }, 40000)
    report("Online: transcrição atribuída aos outros", Boolean(lines), lines ?? { panel: await panelStatus(page) })
    const guidance = await waitFor(page, async () => {
      const value = await card(page)
      return value.status === "APROFUNDAR" ? value : null
    }, 25000)
    report("Online: mostra a sugestão da IA no cartão", Boolean(guidance), guidance ?? (await card(page)))
    report("Online (outros): sem erros na página", errors.length === 0, errors)
    await screenshot(page, "online-outros")
    await browser.close()
  }

  // 3. Online, the user speaks: the meeting is silent, the mic carries the user's question.
  {
    const browser = await launch("me.wav")
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    const errors = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await fakeClaude(page)
    await shareMeetingClip(page, "silence.wav")
    await page.goto(appUrl)
    await prepareAndStart(page, "Reunião online pelo navegador", "Online (você)")
    await page.click("text=Conectar áudio da reunião")
    await waitFor(page, async () => (await page.locator("text=Ouvindo a reunião").count()) > 0, 15000)
    const speaker = await waitFor(page, async () => {
      const value = await activeSpeaker(page)
      return value && /Eu/i.test(value) ? value : null
    }, 15000)
    report("Online: detecta sozinho que VOCÊ está falando", Boolean(speaker), speaker ?? (await activeSpeaker(page)))
    const lines = await waitFor(page, async () => {
      const found = await transcript(page)
      return found.some((text) => text.startsWith("Você:")) ? found : null
    }, 40000)
    report("Online: transcrição atribuída a você", Boolean(lines), lines ?? { panel: await panelStatus(page) })
    const guidance = await waitFor(page, async () => {
      const value = await card(page)
      return value.status === "OUVIR" && /perguntou/.test(value.reading) ? value : null
    }, 25000)
    report("Online: depois da sua pergunta, a IA manda OUVIR", Boolean(guidance), guidance ?? (await card(page)))
    report("Online (você): sem erros na página", errors.length === 0, errors)
    await screenshot(page, "online-voce")
    await browser.close()
  }
}

main()
  .catch((error) => {
    failures += 1
    console.log(`FAIL | erro inesperado | ${error && error.stack ? error.stack : error}`)
  })
  .finally(() => {
    server.close()
    console.log(`RESULT | ${failures === 0 ? "all passed" : `${failures} failed`}`)
    process.exit(failures === 0 ? 0 : 1)
  })
