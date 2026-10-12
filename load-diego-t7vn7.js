var PaymentManager = (function () {
  var config = {
    minAmount: 30,
    modalActiveClass: "ativo",
    storageKey: "utm_params_vivaz",
    apiEndpoint: "/api/criar-luz",
    sseEndpoint: "/api/posicao-eclipse",
    qrErrorMarkup:
      '<div style="color:#cc3333;padding:18px;font-size:13px">QR Code indisponível</div>',
  };

  var state = {
    currentSSE: null,
    currentTxId: null,
    currentEventId: null,
    currentAmountValue: 0,
  };

  window.dataLayer = window.dataLayer || [];

  function readCookie(name) {
    var match = document.cookie.match(
      new RegExp("(^|; *)" + name + "=([^;]*)")
    );
    return match ? decodeURIComponent(match[2]) : null;
  }

  // fbclid chega na URL do clique no anúncio. A tag do GTM já monta o _fbc a
  // partir dele; guardamos aqui como rede de segurança.
  (function storeFbclid() {
    var fbclid = new URLSearchParams(window.location.search).get("fbclid");
    if (fbclid) {
      try {
        localStorage.setItem("fbclid", fbclid);
        localStorage.setItem("fbclid_ts", String(Date.now()));
      } catch (e) {}
    }
  })();

  // O fbclid da URL atual tem prioridade sobre o que ficou guardado, para a
  // venda não ser creditada a um anúncio antigo.
  function getFbc() {
    var current = new URLSearchParams(window.location.search).get("fbclid");
    var ts = null;
    try {
      ts = localStorage.getItem("fbclid_ts");
    } catch (e) {}
    if (current) return "fb.1." + (ts || Date.now()) + "." + current;
    var cookie = readCookie("_fbc");
    if (cookie) return cookie;
    var stored = null;
    try {
      stored = localStorage.getItem("fbclid");
    } catch (e) {}
    return stored ? "fb.1." + (ts || Date.now()) + "." + stored : null;
  }

  // Mesmo identificador de visitante que a tag do GTM grava. Serve de
  // external_id e de client_id, e amarra o evento do navegador ao do servidor.
  function getVisitorId() {
    try {
      return localStorage.getItem("_sgtm_cid");
    } catch (e) {
      return null;
    }
  }

  // event_id compartilhado entre navegador e servidor: é ele que faz a Meta
  // deduplicar o Purchase do navegador contra o Purchase do servidor.
  function newEventId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "e-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
  }

  var elements = {};

  function storeUtmData() {
    var params = new URLSearchParams(window.location.search);
    var utmData = {
      src: null,
      sck: null,
      utm_source: params.get("utm_source"),
      utm_campaign: params.get("utm_campaign"),
      utm_medium: params.get("utm_medium"),
      utm_content: params.get("utm_content"),
      utm_term: params.get("utm_term"),
    };
    localStorage.setItem(config.storageKey, JSON.stringify(utmData));
  }

  function loadUtmData() {
    var stored = localStorage.getItem(config.storageKey);
    return stored ? JSON.parse(stored) || {} : {};
  }

  function cacheElements() {
    elements.modal = document.getElementById("janela-principal");
    elements.closeBtn = document.getElementById("btn-fechar");
    elements.amountDisplay = document.getElementById("exibe-quantia");
    elements.qrContainer = document.getElementById("area-codigo");
    elements.pixCode = document.getElementById("campo-chave");
    elements.copyBtn = document.getElementById("acao-copiar");
    elements.valueButtons = document.querySelectorAll("[data-qv]");
  }

  function displayModal() {
    if (!elements.modal) return;
    elements.modal.style.display = "flex";
    document.body.style.overflow = "hidden";
    setTimeout(function () {
      elements.modal.classList.add(config.modalActiveClass);
    }, 11);
  }

  function hideModal() {
    if (!elements.modal) return;
    elements.modal.classList.remove(config.modalActiveClass);
    document.body.style.overflow = "";
    setTimeout(function () {
      elements.modal.style.display = "none";
      clearModalData();
    }, 260);
    if (state.currentSSE) {
      state.currentSSE.close();
      state.currentSSE = null;
    }
  }

  function clearModalData() {
    if (elements.qrContainer) elements.qrContainer.innerHTML = "";
    if (elements.pixCode) elements.pixCode.textContent = "";
    state.currentTxId = null;
  }

  function formatCurrency(cents) {
    var reais = cents / 100;
    return "R$ " + reais.toFixed(2).replace(".", ",");
  }

  async function requestPixCode(amount) {
    var utmParams = loadUtmData();
    var payload = {
      item_cents: amount * 100,
      utm_params: utmParams,
      // Sinais do navegador: o servidor guarda e usa no Purchase da CAPI,
      // quando o doador já saiu da página para pagar no app do banco.
      event_id: state.currentEventId,
      fbp: readCookie("_fbp"),
      fbc: getFbc(),
      visitor_id: getVisitorId(),
      event_source_url: location.origin + location.pathname,
    };

    var response = await fetch(config.apiEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      var errData = await response.json().catch(function () {
        return {};
      });
      throw new Error(errData.error || "HTTP " + response.status);
    }

    var data = await response.json();

    if (!data.transaction_id || !data.qrcode_text) {
      throw new Error("Servidor não respondeu corretamente");
    }

    return data;
  }

  function renderQRCode(pixData) {
    if (!elements.qrContainer) return;

    if (pixData.qrcode) {
      elements.qrContainer.innerHTML = pixData.qrcode;
    } else if (pixData.qrcode_text && typeof QRCode !== "undefined") {
      elements.qrContainer.innerHTML = "";
      QRCode.toCanvas(
        pixData.qrcode_text,
        { width: 265 },
        function (error, canvas) {
          if (error) {
            elements.qrContainer.innerHTML = config.qrErrorMarkup;
          } else {
            elements.qrContainer.appendChild(canvas);
          }
        }
      );
    }
  }

  function watchPaymentStatus(txId) {
    if (state.currentSSE) state.currentSSE.close();

    var eventSource = new EventSource(config.sseEndpoint + "/" + txId);
    state.currentSSE = eventSource;

    eventSource.onmessage = function (event) {
      var data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      if (data.status === "paid") {
        try {
          // Purchase do navegador, com o MESMO event_id do Purchase que o
          // servidor manda pela CAPI: a Meta deduplica e conta uma vez só.
          window.dataLayer.push({
            event: "Purchase",
            currency: "BRL",
            value: state.currentAmountValue,
            event_id: state.currentEventId,
          });
        } catch (err) {}

        if (eventSource) {
          eventSource.close();
          state.currentSSE = null;
        }

        setTimeout(hideModal, 5100);
      }
    };

    eventSource.onerror = function () {
      if (eventSource) {
        eventSource.close();
        state.currentSSE = null;
      }
    };
  }

  async function handleValueClick(amount) {
    if (!amount || isNaN(amount) || amount < config.minAmount) {
      alert("Quantia inválida.");
      return;
    }

    var btnClicked;
    for (var i = 0; i < elements.valueButtons.length; i++) {
      var btn = elements.valueButtons[i];
      if (parseInt(btn.getAttribute("data-qv")) === amount) {
        btnClicked = btn;
        break;
      }
    }

    if (btnClicked) {
      for (var j = 0; j < elements.valueButtons.length; j++) {
        elements.valueButtons[j].disabled = true;
      }
      btnClicked.innerHTML = '<span class="v-cur">Preparando seu PIX...</span>';
    }

    // Um event_id por tentativa de pagamento. O servidor guarda e reusa no
    // Purchase da CAPI, para navegador e servidor não contarem duas vezes.
    state.currentEventId = newEventId();
    state.currentAmountValue = amount;

    window.dataLayer.push({
      event: "InitiateCheckout",
      currency: "BRL",
      value: amount,
      event_id: state.currentEventId,
    });

    try {
      if (elements.amountDisplay) {
        elements.amountDisplay.textContent = "R$ " + amount + ",00";
      }
      displayModal();

      var pixData = await requestPixCode(amount);
      state.currentTxId = pixData.transaction_id;
      // A trava por IP devolve o PIX da primeira geração, com o event_id
      // dela. Adotamos esse para o Purchase do navegador deduplicar certo.
      if (pixData.event_id) state.currentEventId = pixData.event_id;
      if (pixData.amount_cents)
        state.currentAmountValue = pixData.amount_cents / 100;

      if (pixData.item_cents && elements.amountDisplay) {
        elements.amountDisplay.textContent = formatCurrency(pixData.item_cents);
      }

      renderQRCode(pixData);

      if (elements.pixCode) {
        elements.pixCode.textContent = pixData.qrcode_text;
      }

      watchPaymentStatus(pixData.transaction_id);
    } catch (error) {
      alert("Não foi possível gerar — tente de novo");
      hideModal();
    } finally {
      if (btnClicked) {
        for (var k = 0; k < elements.valueButtons.length; k++) {
          var btn = elements.valueButtons[k];
          btn.disabled = false;
          var val = parseInt(btn.getAttribute("data-qv"));
          var disp = val >= 1000 ? val.toLocaleString("pt-BR") : String(val);
          btn.innerHTML = '<span class="v-cur">R$</span>' + disp;
        }
      }
    }
  }

  function copyToClipboard() {
    var code = elements.pixCode ? elements.pixCode.textContent : "";
    if (!code || code === "carregando…") {
      alert("Aguarde o PIX antes de copiar");
      return;
    }

    navigator.clipboard
      .writeText(code)
      .then(function () {
        var originalHTML = elements.copyBtn.innerHTML;
        elements.copyBtn.innerHTML =
          "<span>" +
          '<svg width="21" height="23" viewBox="0 0 21 23" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10.5" cy="11.5" r="9.5" stroke="#278086" stroke-width="3"/><path d="M6 12.5l3 3 6-7" stroke="#278086" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '<span class="msg-luz-copy">PIX copiado · cole no app</span>' +
          "</span>";
        setTimeout(function () {
          elements.copyBtn.innerHTML = originalHTML;
        }, 2100);
      })
      .catch(function () {
        alert("Falha na cópia · copie manualmente");
        if (elements.pixCode && elements.pixCode.select) {
          elements.pixCode.select();
        }
      });
  }

  function bindEvents() {
    if (elements.closeBtn) {
      elements.closeBtn.addEventListener("click", hideModal);
    }

    if (elements.modal) {
      elements.modal.addEventListener("click", function (e) {
        if (e.target === elements.modal) {
          hideModal();
        }
      });
    }

    document.addEventListener("keydown", function (e) {
      if (
        e.key === "Escape" &&
        elements.modal &&
        elements.modal.classList.contains(config.modalActiveClass)
      ) {
        hideModal();
      }
    });

    if (elements.copyBtn) {
      elements.copyBtn.addEventListener("click", copyToClipboard);
    }

    var i = 0;
    while (i < elements.valueButtons.length) {
      var btn = elements.valueButtons[i];
      btn.addEventListener("click", function () {
        var value = parseInt(this.getAttribute("data-qv"));
        handleValueClick(value);
      });
      i++;
    }

    var advanceBtn = document.getElementById("btn-avancar");
    var customInput = document.getElementById("campo-quantia");
    if (advanceBtn && customInput) {
      advanceBtn.addEventListener("click", function () {
        var value = parseInt(customInput.value, 10);
        if (!value || isNaN(value) || value < config.minAmount) {
          alert("Valor mínimo: R$ " + config.minAmount);
          customInput.focus();
          return;
        }
        handleValueClick(value);
      });
    }

    var anchors = document.querySelectorAll('a[href^="#"]');
    for (var j = 0; j < anchors.length; j++) {
      anchors[j].addEventListener("click", function (e) {
        e.preventDefault();
        var target = document.querySelector(this.getAttribute("href"));
        if (target) {
          target.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }
      });
    }
  }

  function init() {
    storeUtmData();
    cacheElements();
    bindEvents();
  }

  return {
    init: init,
  };
})();

PaymentManager.init();
