"use strict";

(function () {
  var GROUP_ORDER = ["Jurnal Indonesia", "Jurnal Internasional", "Buku Gratis", "Repositori/Platform"];

  var searchForm = document.getElementById("search-form");
  var searchInput = document.getElementById("q");
  var searchBtn = document.getElementById("search-btn");
  var resultsStatus = document.getElementById("results-status");
  var sourceStatus = document.getElementById("source-status");
  var resultList = document.getElementById("result-list");
  var filterInput = document.getElementById("filter");
  var directoryGroups = document.getElementById("directory-groups");
  var directoryEmpty = document.getElementById("directory-empty");

  var directoryEntries = [];
  var searchSeq = 0;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderDirectory() {
    var q = (filterInput.value || "").trim().toLowerCase();
    directoryGroups.replaceChildren();
    var shown = 0;
    GROUP_ORDER.forEach(function (group) {
      var cards = directoryEntries.filter(function (e) {
        if (e.group !== group) return false;
        if (!q) return true;
        var hay = ((e.name || "") + " " + (e.note || "")).toLowerCase();
        return hay.indexOf(q) !== -1;
      });
      if (cards.length === 0) return;
      shown += cards.length;
      var h = el("h3", "group-heading", group);
      directoryGroups.appendChild(h);
      var grid = el("div", "dir-grid");
      cards.forEach(function (e) {
        var card = el("article", "dir-card");
        var title = el("h3");
        var a = document.createElement("a");
        a.href = e.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = e.name;
        title.appendChild(a);
        card.appendChild(title);
        if (e.note) card.appendChild(el("p", null, e.note));
        var visit = document.createElement("a");
        visit.href = e.url;
        visit.target = "_blank";
        visit.rel = "noopener";
        visit.className = "visit";
        visit.textContent = "Kunjungi situs";
        card.appendChild(visit);
        grid.appendChild(card);
      });
      directoryGroups.appendChild(grid);
    });
    directoryEmpty.hidden = shown !== 0;
  }

  function renderSourceStatus(sources) {
    sourceStatus.replaceChildren();
    if (!sources || sources.length === 0) {
      sourceStatus.hidden = true;
      return;
    }
    sources.forEach(function (s) {
      var chip = el("span", s.status === "ok" ? null : "down",
        s.name + ": " + (s.status === "ok" ? s.count + " hasil" : "tidak menjawab"));
      sourceStatus.appendChild(chip);
    });
    sourceStatus.hidden = false;
  }

  function runSearch(q) {
    var query = (q || "").trim();
    var seq = ++searchSeq;
    if (query.length < 2) {
      resultsStatus.textContent = "Kata kunci minimal 2 karakter.";
      resultsStatus.className = "results-status error";
      sourceStatus.hidden = true;
      resultList.replaceChildren();
      return;
    }
    resultsStatus.textContent = "Mencari di 6 sumber...";
    resultsStatus.className = "results-status";
    sourceStatus.hidden = true;
    resultList.replaceChildren();
    searchBtn.disabled = true;
    searchBtn.textContent = "Mencari...";
    fetch("/api/search?q=" + encodeURIComponent(query))
      .then(function (res) {
        if (!res.ok) throw new Error("search failed");
        return res.json();
      })
      .then(function (data) {
        if (seq !== searchSeq) return;
        var results = Array.isArray(data.results) ? data.results : [];
        renderSourceStatus(data.sources);
        if (results.length === 0) {
          resultsStatus.textContent = "Tidak ada hasil untuk \"" + query + "\". Coba kata kunci lain.";
        } else {
          resultsStatus.textContent = results.length + " hasil untuk \"" + query + "\".";
        }
        results.forEach(function (r) {
          var li = document.createElement("li");
          var title = document.createElement("a");
          title.className = "result-title";
          title.href = r.url;
          title.target = "_blank";
          title.rel = "noopener";
          title.textContent = r.title || r.url;
          li.appendChild(title);
          var meta = [];
          if (r.source) meta.push(r.source);
          if (r.year) meta.push(String(r.year));
          if (meta.length) li.appendChild(el("p", "result-meta", meta.join("  |  ")));
          if (r.description) li.appendChild(el("p", "result-desc", r.description));
          var open = document.createElement("a");
          open.className = "result-link";
          open.href = r.url;
          open.target = "_blank";
          open.rel = "noopener";
          open.textContent = "Buka di situs aslinya";
          li.appendChild(open);
          resultList.appendChild(li);
        });
      })
      .catch(function () {
        if (seq !== searchSeq) return;
        resultsStatus.textContent = "Pencarian gagal dimuat. Coba lagi sebentar lagi.";
        resultsStatus.className = "results-status error";
      })
      .then(function () {
        searchBtn.disabled = false;
        searchBtn.textContent = "Cari";
      });
  }

  function syncSearchUrl(q) {
    try {
      var url = new URL(window.location.href);
      if (q) url.searchParams.set("q", q);
      else url.searchParams.delete("q");
      window.history.replaceState(null, "", url.toString());
    } catch (e) { /* ignore */ }
  }

  searchForm.addEventListener("submit", function (event) {
    event.preventDefault();
    syncSearchUrl(searchInput.value.trim());
    runSearch(searchInput.value);
  });

  filterInput.addEventListener("input", renderDirectory);

  fetch("/journals.json")
    .then(function (res) {
      if (!res.ok) throw new Error("directory failed");
      return res.json();
    })
    .then(function (data) {
      var list = Array.isArray(data) ? data : (data.entries || []);
      directoryEntries = list.filter(function (e) { return e && !e.hidden; });
      renderDirectory();
    })
    .catch(function () {
      directoryGroups.replaceChildren();
      directoryGroups.appendChild(el("p", null, "Direktori gagal dimuat. Muat ulang halaman dan coba lagi."));
    });

  var initialQ = new URLSearchParams(window.location.search).get("q") || "";
  if (initialQ) {
    searchInput.value = initialQ;
    runSearch(initialQ);
  }
})();
