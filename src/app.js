import { parseMIDI, getNotes, cleanNotes, writeMIDI } from "./midi.js";

const $ = id => document.getElementById(id);
const EMPTY_TRACKS_HTML = '<p class="muted">MIDIを読み込むとトラックが表示されます。</p>';
const INITIAL_STATUS = "MIDIファイルを読み込んでください。";

let midi = null;
let outputName = "cleaned.mid";
let keepUnselected = true;

function setStatus(message, success = false) {
  $("status").textContent = message;
  $("status").className = success ? "status success" : "status";
}

function selectedTracks() {
  return new Set([...document.querySelectorAll("[data-track-index]:checked")].map(input => Number(input.dataset.trackIndex)));
}

function updateSelection() {
  const count = selectedTracks().size;
  $("selection").textContent = `対象トラック：${count} / ${midi?.tracks.length ?? 0}`;
  $("process").disabled = !midi || count === 0;
}

function updateKeepToggle() {
  $("toggleKeep").classList.toggle("on", keepUnselected);
  $("toggleKeep").setAttribute("aria-checked", String(keepUnselected));
  $("keepHint").textContent = keepUnselected
    ? "ON：処理せずそのまま出力します。"
    : "OFF：出力から削除します（テンポ・拍子・調号は保持）。";
}

function renderTracks() {
  const container = $("tracks");
  container.replaceChildren();

  midi.tracks.forEach((track, index) => {
    const label = document.createElement("label");
    label.className = "track";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.trackIndex = String(index);
    checkbox.addEventListener("change", updateSelection);

    const details = document.createElement("span");
    details.className = "track-details";
    const title = document.createElement("strong");
    title.textContent = track.name;
    const noteCount = document.createElement("small");
    noteCount.textContent = `${getNotes(track).length} notes · Track ${index + 1}`;
    details.append(title, noteCount);

    const number = document.createElement("span");
    number.className = "pill";
    number.textContent = String(index + 1);
    label.append(checkbox, details, number);
    container.append(label);
  });

  $("all").disabled = false;
  $("none").disabled = false;
  updateSelection();
}

function clearFile() {
  midi = null;
  outputName = "cleaned.mid";
  $("file").value = "";
  $("fileInfo").textContent = "";
  $("pickedBar").hidden = true;
  $("dropZone").hidden = false;
  $("tracks").innerHTML = EMPTY_TRACKS_HTML;
  $("all").disabled = true;
  $("none").disabled = true;
  $("stats").hidden = true;
  updateSelection();
  setStatus(INITIAL_STATUS);
}

function loadFile(file) {
  if (!file) return;
  if (!/\.(mid|midi)$/i.test(file.name)) {
    $("file").value = "";
    setStatus("MIDIファイル（.mid / .midi）を選択してください。");
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    try {
      midi = parseMIDI(reader.result);
      outputName = `${file.name.replace(/\.(mid|midi)$/i, "")}_cleaned.mid`;
      $("fileInfo").textContent = `${file.name} · ${midi.tracks.length} tracks · format ${midi.format}`;
      $("fileInfo").title = $("fileInfo").textContent;
      $("pickedBar").hidden = false;
      $("dropZone").hidden = true;
      renderTracks();
      $("stats").hidden = true;
      setStatus("読み込み完了。処理するトラックを選択してください。", true);
    } catch (error) {
      midi = null;
      $("file").value = "";
      $("pickedBar").hidden = true;
      $("dropZone").hidden = false;
      $("tracks").innerHTML = EMPTY_TRACKS_HTML;
      $("all").disabled = true;
      $("none").disabled = true;
      updateSelection();
      setStatus(`読み込みエラー：${error.message}`);
    }
  };
  reader.onerror = () => setStatus("ファイルを読み込めませんでした。");
  reader.readAsArrayBuffer(file);
}

$("file").addEventListener("change", event => loadFile(event.target.files[0]));
$("clearBtn").addEventListener("click", clearFile);
$("all").addEventListener("click", () => {
  document.querySelectorAll("[data-track-index]").forEach(input => input.checked = true);
  updateSelection();
});
$("none").addEventListener("click", () => {
  document.querySelectorAll("[data-track-index]").forEach(input => input.checked = false);
  updateSelection();
});
$("tracks").addEventListener("change", updateSelection);
$("toggleKeep").addEventListener("click", () => {
  keepUnselected = !keepUnselected;
  updateKeepToggle();
});

const dropZone = $("dropZone");
dropZone.addEventListener("dragover", event => {
  event.preventDefault();
  dropZone.classList.add("dragging");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
dropZone.addEventListener("drop", event => {
  event.preventDefault();
  dropZone.classList.remove("dragging");
  loadFile(event.dataTransfer.files[0]);
});

$("process").addEventListener("click", () => {
  try {
    const selected = selectedTracks();
    let before = 0, after = 0;
    midi.tracks.forEach((track, index) => {
      const notes = getNotes(track);
      before += notes.length;
      if (selected.has(index)) after += cleanNotes(notes).length;
      else if (keepUnselected) after += notes.length;
    });

    const blob = writeMIDI(midi, selected, { keepUnselected });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = outputName;
    link.click();
    URL.revokeObjectURL(url);

    $("before").textContent = String(before);
    $("after").textContent = String(after);
    $("removed").textContent = String(before - after);
    $("stats").hidden = false;

    const dropped = keepUnselected ? 0 : midi.tracks.length - selected.size;
    setStatus(
      dropped > 0
        ? `${selected.size} トラックを処理し、${dropped} トラックを削除してMIDIを書き出しました。`
        : `${selected.size} トラックを処理し、MIDIを書き出しました。`,
      true
    );
  } catch (error) {
    setStatus(`処理エラー：${error.message}`);
  }
});

updateKeepToggle();