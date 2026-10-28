const fileInput = document.getElementById("fileInput");
const fileList = document.getElementById("fileList");
const jsOutput = document.getElementById("jsOutput");

const WORDS_PER_MINUTE = 50;
const FIXED_QUESTION_SECONDS = 60;

// Video: secondi aggiunti per ogni domanda.
const VIDEO_SECONDS_PER_QUESTION = 3;

// Per le FIT il campo e.v contiene le risposte accettate.
// true = conta tutte le varianti, false = conta solo la prima.
const FIT_COUNT_ALL_ANSWERS = true;

// Nelle FIT le risposte vengono conteggiate come parole intere.
const FIT_SUBTRACT_ONE_WORD = false;

const questionTotals = {
  MC: 0,
  TF: 0,
  FIB: 0,
  SID: 0,
  FIT: 0,
  SQ: 0,
};

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    seconds = 0;
  }

  seconds = Math.round(seconds);

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return (
      String(hours).padStart(2, "0") +
      ":" +
      String(minutes).padStart(2, "0") +
      ":" +
      String(secs).padStart(2, "0")
    );
  }

  return String(minutes).padStart(2, "0") + ":" + String(secs).padStart(2, "0");
}

function cleanText(value) {
  if (typeof value !== "string") {
    return "";
  }

  const withoutCode = value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");

  // DOMParser non esegue script né carica risorse.
  const doc = new DOMParser().parseFromString(withoutCode, "text/html");

  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

function countWords(text) {
  const cleaned = cleanText(text);

  if (!cleaned) {
    return 0;
  }

  return cleaned.split(/\s+/).filter(Boolean).length;
}

// Conta le parole togliendone una, con minimo 0.
// Vale per ogni singola risposta MC, TF e SID.
function countWordsMinusOne(text) {
  return Math.max(0, countWords(text) - 1);
}

function wordsToSeconds(words) {
  return (words / WORDS_PER_MINUTE) * 60;
}

function getExerciseType(name) {
  const normalized = (name || "").replace(/_\d+$/, "").trim().toLowerCase();

  if (normalized.includes("vero/falso")) {
    return "TF";
  }

  if (normalized.includes("scelte multiple")) {
    return "MC";
  }

  if (normalized.includes("domanda di completamento")) {
    return "FIB";
  }

  if (normalized.includes("controllo a discesa")) {
    return "SID";
  }

  if (normalized.includes("voce testuale")) {
    return "FIT";
  }

  if (normalized.includes("sequenza di domande")) {
    return "SQ";
  }

  return null;
}

// Legge il testo di un componente ActivePresenter.
// In ogni stato, t[0] è l'HTML del testo.
function getComponentText(component) {
  if (!component || !Array.isArray(component.s)) {
    return "";
  }

  const texts = [];

  component.s.forEach((state) => {
    if (!Array.isArray(state.t)) {
      return;
    }

    const text = cleanText(state.t[0]);

    if (text && !texts.includes(text)) {
      texts.push(text);
    }
  });

  return texts.join(" ").trim();
}

// Estrae le risposte disponibili di una domanda.

function getAnswers(component, type, slideComponents = []) {
  const answers = [];
  const seen = new Set();

  function add(text) {
    const cleaned = cleanText(text);
    if (!cleaned) return;

    const normalized = cleaned.toLowerCase();

    if (!seen.has(normalized)) {
      seen.add(normalized);
      answers.push(cleaned);
    }
  }

  // FIT: risposte accettate.
  if (type === "FIT") {
    const values =
      component.e && Array.isArray(component.e.v) ? component.e.v : [];

    const strings = values.filter((value) => typeof value === "string");

    (FIT_COUNT_ALL_ANSWERS ? strings : strings.slice(0, 1)).forEach(add);

    return answers;
  }

  if (!["MC", "TF", "SID"].includes(type)) {
    return answers;
  }

  const visited = new WeakSet();

  function scanComponent(item, includeAllText = true) {
    if (!item || typeof item !== "object") return;
    if (visited.has(item)) return;

    visited.add(item);

    const name = (item.n || "").toLowerCase();

    // Per le MC privilegia i componenti che rappresentano
    // effettivamente le risposte.
    const isAnswerComponent = /pulsante di scelta|risposta|opzione/.test(name);

    if (includeAllText || isAnswerComponent) {
      add(getComponentText(item));

      if (typeof item.t === "string") {
        add(item.t);
      }
    }

    if (Array.isArray(item.cc)) {
      item.cc.forEach((child) => scanComponent(child, true));
    }

    ["o", "options", "items", "l"].forEach((key) => {
      if (!Array.isArray(item[key])) return;

      item[key].forEach((option) => {
        if (typeof option === "string") {
          add(option);
        } else {
          scanComponent(option, true);
        }
      });
    });
  }

  // Prima ricerca all'interno della domanda.
  if (Array.isArray(component.cc)) {
    component.cc.forEach((item) => scanComponent(item, true));
  }

  // Poi ricerca nei componenti della diapositiva,
  // comprese le strutture intermedie che contengono
  // i pulsanti delle risposte MC.
  if (type === "MC") {
    slideComponents.forEach((item) => {
      if (!item || item === component) return;

      const name = (item.n || "").toLowerCase();

      if (/pulsante di scelta|risposta|opzione/.test(name)) {
        scanComponent(item, true);
      } else if (Array.isArray(item.cc)) {
        item.cc.forEach((child) => {
          const childName = (child?.n || "").toLowerCase();

          if (/pulsante di scelta|risposta|opzione/.test(childName)) {
            scanComponent(child, true);
          }
        });
      }
    });
  }

  return answers;
}

// Estrae un oggetto delimitato da parentesi graffe,
// rispettando stringhe, commenti e parentesi annidate.
function extractObject(source, startIndex) {
  const start = source.indexOf("{", startIndex);

  if (start === -1) {
    throw new Error("Oggetto JavaScript non trovato.");
  }

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = start; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;

      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  throw new Error("Oggetto incompleto: parentesi non bilanciate.");
}

// Converte l'oggetto pools in dati utilizzabili.
function parsePools(content) {
  const poolsIndex = content.indexOf("pools:");

  if (poolsIndex === -1) {
    throw new Error("Sezione 'pools' non trovata in rlprez.js.");
  }

  const poolsSource = extractObject(content, poolsIndex);

  // rlprez.js contiene una struttura JavaScript, non JSON.
  // L'esecuzione è limitata al file locale selezionato.
  const pools = Function('"use strict"; return (' + poolsSource + ");")();

  return Object.values(pools).filter(Array.isArray);
}

// Cerca il testo della domanda fra i componenti della slide.
// Preferisce un componente il cui nome contiene "Titolo".
function findQuestionText(components, questionIndex) {
  const candidates = [];

  for (let i = 0; i < components.length; i++) {
    if (i === questionIndex) {
      continue;
    }

    const component = components[i];
    const name = (component.n || "").toLowerCase();

    // Evita pulsanti, risposte e componenti interattivi.
    if (
      name.includes("pulsante") ||
      name.includes("risposta") ||
      name.includes("opzione") ||
      name.includes("scelta") ||
      name.includes("domanda con") ||
      name === "invia"
    ) {
      continue;
    }

    const text = getComponentText(component);

    if (!text) {
      continue;
    }

    candidates.push({
      index: i,
      name: name,
      text: text,
    });
  }

  // Prima cerca un titolo collocato prima della domanda.
  const previousTitles = candidates
    .filter(
      (item) => item.index < questionIndex && item.name.includes("titolo"),
    )
    .sort((a, b) => b.index - a.index);

  if (previousTitles.length > 0) {
    return previousTitles[0].text;
  }

  // In assenza di un titolo, prova il componente
  // testuale immediatamente precedente.
  const previousComponents = candidates
    .filter((item) => item.index < questionIndex)
    .sort((a, b) => b.index - a.index);

  if (previousComponents.length > 0) {
    return previousComponents[0].text;
  }

  return "";
}

function analyzeQuestions(content) {
  const pools = parsePools(content);
  const details = [];
  let poolsWithQuestions = 0;

  Object.keys(questionTotals).forEach((type) => {
    questionTotals[type] = 0;
  });

  pools.forEach((slides) => {
    let poolHasQuestions = false;

    slides.forEach((slide) => {
      const components = Array.isArray(slide.cc) ? slide.cc : [];

      components.forEach((component, index) => {
        const type = getExerciseType(component.n);

        if (!type) {
          return;
        }

        poolHasQuestions = true;

        const questionText = findQuestionText(components, index);

        // Parole della domanda: conteggio completo.
        const questionWords = countWords(questionText);

        // FIB e SQ hanno durata fissa.
        const answers =
          type === "FIB" || type === "SQ"
            ? []
            : getAnswers(component, type, components);
        // Calcolo delle parole delle risposte.
        const answerWords = answers.reduce((sum, answer) => {
          if (type === "FIT") {
            return (
              sum +
              (FIT_SUBTRACT_ONE_WORD
                ? countWordsMinusOne(answer)
                : countWords(answer))
            );
          }

          // MC, TF e SID: conta tutte le parole della risposta.
          return sum + countWords(answer);
        }, 0);

        let questionSeconds;
        let answerSeconds;

        if (type === "FIB" || type === "SQ") {
          questionSeconds = FIXED_QUESTION_SECONDS;
          answerSeconds = 0;
        } else {
          questionSeconds = wordsToSeconds(questionWords);
          answerSeconds = wordsToSeconds(answerWords);
        }

        const seconds = questionSeconds + answerSeconds;

        questionTotals[type] += seconds;

        details.push({
          slide: slide.at || "Slide senza nome",
          tipo: type,
          domanda: questionText || "(testo non individuato)",
          parole: questionWords,
          risposte: answers.length,
          testoRisposte: answers,
          paroleRisposte: answerWords,
          secondi: seconds,
        });
      });
    });

    if (poolHasQuestions) {
      poolsWithQuestions++;
    }
  });

  return {
    details,
    poolsWithQuestions,
  };
}

function getElement(id) {
  let element = document.getElementById(id);

  if (!element) {
    element = document.createElement("div");
    element.id = id;
    document.body.appendChild(element);
  }

  return element;
}

function showError(message) {
  const output = getElement("analysisResults");

  output.innerHTML = "";

  const error = document.createElement("p");
  error.style.color = "#b00020";
  error.textContent = "Errore: " + message;

  output.appendChild(error);
}

// Legge la durata effettiva del video usando un URL locale.
function getVideoDurationFromURL(url) {
  return new Promise((resolve) => {
    const video = document.createElement("video");

    video.preload = "metadata";

    let finished = false;

    function finish(seconds) {
      if (finished) {
        return;
      }

      finished = true;

      video.removeAttribute("src");
      video.load();

      URL.revokeObjectURL(url);

      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    }

    video.onloadedmetadata = () => {
      finish(video.duration);
    };

    video.onerror = () => {
      finish(0);
    };

    video.src = url;
  });
}

async function analyzeSCORM(file) {
  if (!file) {
    return;
  }

  const output = getElement("analysisResults");

  output.innerHTML = "<p>Analisi del pacchetto SCORM in corso...</p>";

  if (typeof JSZip === "undefined") {
    showError(
      "JSZip non è caricato. Includi la libreria JSZip prima di script.js.",
    );
    return;
  }

  try {
    const zip = await JSZip.loadAsync(file);

    const files = [];
    const videoEntries = [];
    let rlprezEntry = null;
    let projectName = "Nome del corso non trovato";

    zip.forEach((relativePath, entry) => {
      if (entry.dir) {
        return;
      }

      files.push(relativePath);

      if (/\.mp4$/i.test(relativePath)) {
        videoEntries.push({
          name: relativePath,
          entry: entry,
        });
      }

      if (/(^|\/)rlprez\.js$/i.test(relativePath)) {
        rlprezEntry = entry;
      }
    });

    // Elenco dei file contenuti nello ZIP, apribile e richiudibile.
    if (fileList) {
      fileList.innerHTML = "";

      const details = document.createElement("details");
      details.className = "files-dropdown";

      const summary = document.createElement("summary");
      summary.textContent = `Visualizza i file trovati (${files.length})`;

      const list = document.createElement("ul");
      list.className = "files-list";

      files.forEach((name) => {
        const li = document.createElement("li");
        li.textContent = name;
        list.appendChild(li);
      });

      details.appendChild(summary);
      details.appendChild(list);
      fileList.appendChild(details);
    }

    // Durata complessiva dei video presenti nello ZIP.
    let baseVideoSeconds = 0;
    const videoDetails = [];

    for (const videoFile of videoEntries) {
      const blob = await videoFile.entry.async("blob");
      const url = URL.createObjectURL(blob);
      const seconds = await getVideoDurationFromURL(url);

      baseVideoSeconds += seconds;

      videoDetails.push({
        name: videoFile.name,
        seconds: seconds,
      });
    }

    let questionDetails = [];
    let poolsWithQuestions = 0;
    let totalQuestionSeconds = 0;
    let questionError = "";

    // Analisi del file runtime di ActivePresenter.
    if (rlprezEntry) {
      const content = await rlprezEntry.async("string");

      const projectMatch = content.match(/projectName\s*:\s*["']([^"']+)["']/);

      if (projectMatch) {
        projectName = projectMatch[1];
      }

      try {
        const analysis = analyzeQuestions(content);

        questionDetails = analysis.details;
        poolsWithQuestions = analysis.poolsWithQuestions;

        totalQuestionSeconds = questionDetails.reduce(
          (sum, question) => sum + question.secondi,
          0,
        );
      } catch (error) {
        questionError = error.message;
      }
    } else {
      questionError = "File rlprez.js non trovato nello ZIP.";
    }

    // Extra video: 3 secondi per domanda.
    // Nessuna aggiunta di stacchetti da 4 secondi.
    const questionVideoSeconds =
      questionDetails.length * VIDEO_SECONDS_PER_QUESTION;

    const totalVideoSeconds = baseVideoSeconds + questionVideoSeconds;

    // Totale complessivo.
    const grandTotalSeconds = totalVideoSeconds + totalQuestionSeconds;

    output.innerHTML = "";

    const title = document.createElement("h2");
    title.textContent = "Risultato analisi SCORM";
    output.appendChild(title);

    const course = document.createElement("p");
    course.textContent = "Corso: " + projectName;
    output.appendChild(course);

    const videoHeading = document.createElement("h3");
    videoHeading.textContent = "Durata dei video";
    output.appendChild(videoHeading);

    const videoList = document.createElement("ul");

    videoDetails.forEach((video) => {
      const li = document.createElement("li");

      li.textContent = video.name + " — " + formatTime(video.seconds);

      videoList.appendChild(li);
    });

    output.appendChild(videoList);

    const videoBase = document.createElement("p");
    videoBase.textContent = "Video nello ZIP: " + formatTime(baseVideoSeconds);

    output.appendChild(videoBase);

    if (!questionError) {
      const extraList = document.createElement("ul");

      const perQuestion = document.createElement("li");

      perQuestion.textContent =
        "Extra " +
        VIDEO_SECONDS_PER_QUESTION +
        " s x " +
        questionDetails.length +
        " domande: " +
        formatTime(questionVideoSeconds);

      extraList.appendChild(perQuestion);

      output.appendChild(extraList);
    }

    const videoTotal = document.createElement("p");

    videoTotal.textContent = "Totale video: " + formatTime(totalVideoSeconds);

    output.appendChild(videoTotal);

    const questionHeading = document.createElement("h3");
    questionHeading.textContent = "Durata dei test";
    output.appendChild(questionHeading);

    if (questionError) {
      const error = document.createElement("p");

      error.style.color = "#b00020";
      error.textContent =
        "Impossibile completare l'analisi dei test: " + questionError;

      output.appendChild(error);
    } else {
      const categoryList = document.createElement("ul");

      Object.keys(questionTotals).forEach((type) => {
        const categoryQuestions = questionDetails.filter(
          (question) => question.tipo === type,
        );

        const li = document.createElement("li");

        li.textContent =
          type +
          ": " +
          categoryQuestions.length +
          " domande — " +
          formatTime(questionTotals[type]);

        categoryList.appendChild(li);
      });

      output.appendChild(categoryList);

      const questionTotal = document.createElement("p");

      questionTotal.textContent =
        "Totale test: " + formatTime(totalQuestionSeconds);

      output.appendChild(questionTotal);

      // Dettaglio delle singole domande.
      const detailHeading = document.createElement("h3");
      detailHeading.textContent = "Dettaglio domande";
      output.appendChild(detailHeading);

      const detailList = document.createElement("ol");

      questionDetails.forEach((question) => {
        const li = document.createElement("li");

        let text =
          "[" +
          question.tipo +
          "] " +
          question.domanda +
          " — domanda: " +
          question.parole +
          " parole";

        if (question.tipo !== "FIB" && question.tipo !== "SQ") {
          text +=
            " — risposte: " +
            question.risposte +
            " (" +
            question.paroleRisposte +
            " parole)";

          // Per le FIT mostra le soluzioni individuate.
          if (question.tipo === "FIT" && question.testoRisposte.length > 0) {
            text += " [soluzione: " + question.testoRisposte.join(" | ") + "]";
          }

          if (question.risposte === 0) {
            text += " ⚠ risposte non individuate";
          }
        }

        text += " — " + formatTime(question.secondi);

        li.textContent = text;
        detailList.appendChild(li);
      });

      output.appendChild(detailList);
    }

    const grandTotal = document.createElement("h3");

    grandTotal.textContent =
      "Durata complessiva stimata: " + formatTime(grandTotalSeconds);

    output.appendChild(grandTotal);

    // Se rlprez.js non è disponibile, non presentare
    // il totale complessivo come una stima completa.
    if (questionError) {
      grandTotal.textContent =
        "Durata video rilevata: " +
        formatTime(baseVideoSeconds) +
        " — durata dei test non calcolata.";
    }

    // Mostra il contenuto di rlprez.js, se richiesto.
    // if (jsOutput && rlprezEntry) {
    //  jsOutput.innerHTML = "";

    // const jsHeading = document.createElement("h3");
    // jsHeading.textContent = "Contenuto di rlprez.js";
    // jsOutput.appendChild(jsHeading);

    //const pre = document.createElement("pre");

    //pre.style.whiteSpace = "pre-wrap";
    // pre.style.overflowWrap = "anywhere";
    // pre.textContent = await rlprezEntry.async("string");

    //  jsOutput.appendChild(pre);
    //}
  } catch (error) {
    console.error(error);
    showError(error.message || "Errore durante l'analisi dello ZIP.");
  }
}

if (fileInput) {
  fileInput.addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];

    if (file) {
      analyzeSCORM(file);
    }
  });
}
