var PaymentManager = (function () {
  var config = {
    minAmount: 30,
    modalActiveClass: "ativo",
    storageKey: "utm_params_vivaz",
    pixKey: "44769766000100",
    merchantName: "ZG NEGOCIOS DIGITAIS LTDA",
    merchantCity: "BELO HORIZONTE",
    qrErrorMarkup:
      '<div style="color:#cc3333;padding:18px;font-size:13px">QR Code indisponível</div>',
  };

  var state = {
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

  // fbclid chega na URL do clique no anúncio. Guardamos aqui como rede de
  // segurança para a atribuição dos eventos.
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

  // Identificador persistido pelo backend, quando disponível.
  function getVisitorId() {
    try {
      return localStorage.getItem("_sgtm_cid");
    } catch (e) {
      return null;
    }
  }

  // Identificador único para cada emissão de Pix.
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
  }

  function clearModalData() {
    if (elements.qrContainer) elements.qrContainer.innerHTML = "";
    if (elements.pixCode) elements.pixCode.value = "";
  }

  function formatCurrency(cents) {
    var reais = cents / 100;
    return "R$ " + reais.toFixed(2).replace(".", ",");
  }

  function emvField(id, value) {
    value = String(value);
    return id + ("0" + value.length).slice(-2) + value;
  }

  function crc16(payload) {
    var crc = 0xFFFF;
    for (var i = 0; i < payload.length; i++) {
      crc ^= payload.charCodeAt(i) << 8;
      for (var bit = 0; bit < 8; bit++) {
        crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
        crc &= 0xFFFF;
      }
    }
    return ("0000" + crc.toString(16).toUpperCase()).slice(-4);
  }

  function requestPixCode(amount) {
    if (config.pixKey.length !== 14 || !/^[0-9]+$/.test(config.pixKey)) {
      throw new Error("A chave Pix informada não é um CNPJ válido.");
    }
    var merchantAccount =
      emvField("00", "br.gov.bcb.pix") + emvField("01", config.pixKey);
    var payload = [
      emvField("00", "01"),
      emvField("01", "11"),
      emvField("26", merchantAccount),
      emvField("52", "0000"),
      emvField("53", "986"),
      emvField("54", Number(amount).toFixed(2)),
      emvField("58", "BR"),
      emvField("59", config.merchantName),
      emvField("60", config.merchantCity),
      emvField("62", emvField("05", "***")),
    ].join("") + "6304";
    return {
      item_cents: Math.round(Number(amount) * 100),
      qrcode_text: payload + crc16(payload),
    };
  }

  function renderQRCode(pixData) {
    if (!elements.qrContainer) return;
    elements.qrContainer.innerHTML = "";
    if (typeof QRCode === "undefined") {
      elements.qrContainer.innerHTML = config.qrErrorMarkup;
      return;
    }
    try {
      new QRCode(elements.qrContainer, {
        text: pixData.qrcode_text,
        width: 265,
        height: 265,
        correctLevel: QRCode.CorrectLevel.M,
      });
    } catch (error) {
      elements.qrContainer.innerHTML = config.qrErrorMarkup;
    }
  }

  function handleValueClick(amount) {
    if (!amount || isNaN(amount) || amount < config.minAmount) {
      alert("Quantia inválida.");
      return;
    }

    var btnClicked;
    for (var i = 0; i < elements.valueButtons.length; i++) {
      var btn = elements.valueButtons[i];
      if (parseInt(btn.getAttribute("data-qv"), 10) === amount) {
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
        elements.amountDisplay.textContent = formatCurrency(amount * 100);
      }
      displayModal();
      var pixData = requestPixCode(amount);
      renderQRCode(pixData);
      if (elements.pixCode) elements.pixCode.value = pixData.qrcode_text;
      if (typeof window.fbq === "function") {
        window.fbq(
          "track",
          "Purchase",
          { currency: "BRL", value: amount },
          { eventID: state.currentEventId }
        );
      }
    } catch (error) {
      alert("Não foi possível gerar o Pix. Tente novamente.");
      hideModal();
    } finally {
      if (btnClicked) {
        for (var k = 0; k < elements.valueButtons.length; k++) {
          var button = elements.valueButtons[k];
          button.disabled = false;
          var val = parseInt(button.getAttribute("data-qv"), 10);
          var display = val >= 1000 ? val.toLocaleString("pt-BR") : String(val);
          button.innerHTML = '<span class="v-cur">R$</span>' + display;
        }
      }
    }
  }

  function copyToClipboard() {
    var code = elements.pixCode ? elements.pixCode.value : "";
    if (!code) {
      alert("Selecione um valor para gerar o Pix.");
      return;
    }

    function showCopied() {
      var originalHTML = elements.copyBtn.innerHTML;
      elements.copyBtn.innerHTML =
        "<span>" +
        '<svg width="21" height="23" viewBox="0 0 21 23" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="10.5" cy="11.5" r="9.5" stroke="#278086" stroke-width="3"/><path d="M6 12.5l3 3 6-7" stroke="#278086" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '<span class="msg-luz-copy">PIX copiado · cole no app</span>' +
        "</span>";
      setTimeout(function () {
        elements.copyBtn.innerHTML = originalHTML;
      }, 2100);
    }

    function fallbackCopy() {
      elements.pixCode.focus();
      elements.pixCode.select();
      try {
        if (document.execCommand("copy")) {
          showCopied();
        } else {
          alert("Código selecionado. Copie e cole no app do banco.");
        }
      } catch (error) {
        alert("Código selecionado. Copie e cole no app do banco.");
      }
    }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(code).then(showCopied).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
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
      btn._vb = true;
      btn.addEventListener("click", function () {
        var value = parseInt(this.getAttribute("data-qv"), 10);
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
