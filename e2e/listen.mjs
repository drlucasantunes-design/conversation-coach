// End-to-end check of the listening features in a real Chrome (run in CI).
// Usage: node e2e/listen.mjs <app.html or https URL> <audio dir>
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
    } else if (url.pathname === "/meeting") {
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end(`<!doctype html><title>Reuniao</title><h1>Reuniao</h1><audio id="a" src="/audio/${url.searchParams.get("clip")}" autoplay loop controls></audio>`)
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  .listen(5199)

// On CI a virtual PulseAudio microphone plays whatever clip MIC_CONTROL names:
// speech recognition reads the system microphone, not Chrome's fake device.
const micControl = process.env.MIC_CONTROL

function launch(micClip, extra = []) {
  if (micControl) fs.writeFileSync(micControl, path.join(audioDir, micClip))
  const fakeMic = micControl
    ? []
    : ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${path.join(audioDir, micClip)}`]
  return chromium.launch({
    channel: channel || undefined,
    headless: process.env.HEADLESS === "1",
    args: ["--use-fake-ui-for-media-stream", ...fakeMic, "--autoplay-policy=no-user-gesture-required", ...extra],
  })
}

async function screenshot(page, name) {
  const data = (await page.screenshot({ type: "jpeg", quality: 35 })).toString("base64")
  for (let index = 0; index < data.length; index += 3000) {
    console.log(`SHOT|${name}|${index / 3000}|${data.slice(index, index + 3000)}`)
  }
  console.log(`SHOT|${name}|end`)
}

async function card(page) {
  return page.evaluate(() => {
    const section = document.querySelector("section[aria-live]")
    if (!section) return null
    const label = section.querySelector("span.font-black")?.textContent ?? ""
    const texts = [...section.querySelectorAll("p")].map((node) => node.textContent)
    return { label, reading: texts[0] ?? "", line: texts[1] ?? "" }
  })
}

async function panelStatus(page) {
  return page.evaluate(() =>
    document.body.innerText
      .split("\n")
      .filter((line) => /transcri|Microfone|microfone|Ouvindo|serviço de voz|Ativando/.test(line))
      .slice(0, 4),
  )
}

async function transcript(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("li")]
      .map((node) => node.textContent)
      .filter((text) => /^(Você|Ela):/.test(text ?? "")),
  )
}

async function activeSpeaker(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("button[aria-pressed=true]")]
      .map((node) => node.textContent ?? "")
      .find((text) => /Eu falo|Ela fala/i.test(text)) ?? null,
  )
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
      new Promise(async (resolve) => {
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition
        if (!Recognition) return resolve({ api: false })
        const out = { api: true, events: [], finals: [], inputs: [], peakDb: null }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
          out.inputs = (await navigator.mediaDevices.enumerateDevices())
            .filter((device) => device.kind === "audioinput")
            .map((device) => device.label)
          const context = new AudioContext()
          const analyser = context.createAnalyser()
          context.createMediaStreamSource(stream).connect(analyser)
          const buffer = new Float32Array(analyser.fftSize)
          let peak = -120
          for (let index = 0; index < 20; index += 1) {
            await new Promise((done) => setTimeout(done, 100))
            analyser.getFloatTimeDomainData(buffer)
            let sum = 0
            for (const sample of buffer) sum += sample * sample
            peak = Math.max(peak, 20 * Math.log10(Math.sqrt(sum / buffer.length) || 1e-9))
          }
          out.peakDb = Math.round(peak)
          stream.getTracks().forEach((track) => track.stop())
          await context.close()
        } catch (error) {
          out.inputs = [`getUserMedia failed: ${error}`]
        }
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
// hands the microphone file back as the "shared tab" audio. Stand in for the
// shared meeting tab with its own, independent audio clip.
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

async function startConversation(page, speakerOption) {
  await page.waitForSelector("text=Começar conversa", { timeout: 15000 })
  await page.click("text=Transcrição ao vivo (pt-BR)")
  await page.click("text=A coordenadora sabe e concorda")
  if (speakerOption) await page.click(`text=${speakerOption}`)
}

async function main() {
  const probeFile = path.join(os.tmpdir(), "probe.html")
  fs.writeFileSync(probeFile, "<!doctype html><meta charset=utf-8><title>probe</title>")
  for (const [name, url] of [["arquivo local (file://)", `file://${probeFile}`], ["site (http://localhost)", "http://localhost:5199/meeting?clip=silence.wav"]]) {
    const result = await rawProbe(url)
    report(`${channel || "chromium"}: reconhecimento de voz direto, ${name}`, result.finals.length > 0, result)
  }
  if (process.env.PROBE_ONLY === "1") return

  // 1. Listen test on the prep screen, then a conversation with manual speaker marking.
  {
    const browser = await launch("her.wav")
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    const errors = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.goto(appUrl)
    await startConversation(page, null)
    await page.click("text=Testar escuta")
    const heard = await waitFor(page, async () => (await page.locator("text=Funcionou: o app está ouvindo.").count()) > 0 && (await page.locator("[data-testid=listen-test-heard]").innerText()), 30000)
    report("Testar escuta mostra a frase ouvida", Boolean(heard), heard || (await panelStatus(page)))
    await page.click("text=Parar teste")

    await page.click("text=Começar conversa")
    await page.waitForTimeout(800)
    await page.keyboard.press("2")
    const lines = await waitFor(page, async () => {
      const found = await transcript(page)
      return found.some((text) => text.startsWith("Ela:")) ? found : null
    }, 40000)
    report("Conversa (manual): transcreve a fala dela", Boolean(lines), lines ?? { transcript: await transcript(page), panel: await panelStatus(page) })
    const guidance = await waitFor(page, async () => {
      const value = await card(page)
      return value?.label === "APROFUNDAR" ? value : null
    }, 20000)
    report("Conversa (manual): coach reage com APROFUNDAR", Boolean(guidance), guidance ?? (await card(page)))
    report("Conversa (manual): sem erros na página", errors.length === 0, errors)
    await screenshot(page, "manual")
    await browser.close()
  }

  // 2. Meeting mode, she speaks: the meeting plays her voice (the mic hears it too, like speakers).
  {
    const browser = await launch("her.wav")
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    const errors = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await shareMeetingClip(page, "her.wav")
    await page.goto(appUrl)
    await startConversation(page, "Automático: reunião no computador (recomendado)")
    await page.click("text=Começar conversa")
    await page.click("text=Conectar áudio da reunião")
    const connected = await waitFor(page, async () => (await page.locator("text=Ouvindo a reunião").count()) > 0, 15000)
    report("Reunião: conecta o áudio da aba da reunião", Boolean(connected), connected ? undefined : await page.locator("p").allInnerTexts())
    const speaker = await waitFor(page, async () => {
      const value = await activeSpeaker(page)
      return value && /Ela/i.test(value) ? value : null
    }, 15000)
    report("Reunião: detecta sozinho que ELA está falando", Boolean(speaker), speaker ?? (await activeSpeaker(page)))
    const lines = await waitFor(page, async () => {
      const found = await transcript(page)
      return found.some((text) => text.startsWith("Ela:")) ? found : null
    }, 40000)
    report("Reunião: transcrição atribuída a ela", Boolean(lines), lines ?? { transcript: await transcript(page), panel: await panelStatus(page) })
    const guidance = await waitFor(page, async () => {
      const value = await card(page)
      return value?.label === "APROFUNDAR" ? value : null
    }, 20000)
    report("Reunião: coach reage com APROFUNDAR", Boolean(guidance), guidance ?? (await card(page)))
    report("Reunião (ela): sem erros na página", errors.length === 0, errors)
    await screenshot(page, "reuniao-ela")
    await browser.close()
  }

  // 3. Meeting mode, the user speaks: the meeting is silent, the mic carries the user's question.
  {
    const browser = await launch("me.wav")
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
    const errors = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await shareMeetingClip(page, "silence.wav")
    await page.goto(appUrl)
    await startConversation(page, "Automático: reunião no computador (recomendado)")
    await page.click("text=Começar conversa")
    await page.click("text=Conectar áudio da reunião")
    await waitFor(page, async () => (await page.locator("text=Ouvindo a reunião").count()) > 0, 15000)
    const speaker = await waitFor(page, async () => {
      const value = await activeSpeaker(page)
      return value && /Eu/i.test(value) ? value : null
    }, 15000)
    report("Reunião: detecta sozinho que VOCÊ está falando", Boolean(speaker), speaker ?? (await activeSpeaker(page)))
    const lines = await waitFor(page, async () => {
      const found = await transcript(page)
      return found.some((text) => text.startsWith("Você:")) ? found : null
    }, 40000)
    report("Reunião: transcrição atribuída a você", Boolean(lines), lines ?? { transcript: await transcript(page), panel: await panelStatus(page) })
    const guidance = await waitFor(page, async () => {
      const value = await card(page)
      return value?.label === "OUVIR" ? value : null
    }, 20000)
    report("Reunião: depois da sua pergunta, coach manda OUVIR", Boolean(guidance), guidance ?? (await card(page)))
    report("Reunião (você): sem erros na página", errors.length === 0, errors)
    await screenshot(page, "reuniao-voce")
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
