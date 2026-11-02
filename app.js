/* Controle de presenca por QR code - aplicativo do monitor.
   Guarda tudo em localStorage e envia para o Apps Script quando ha internet. */

(function () {
  'use strict';

  var CHAVES = {
    config: 'presenca.config',
    fila: 'presenca.fila',
    alunos: 'presenca.alunos',
    hoje: 'presenca.hoje'
  };

  var config = ler(CHAVES.config, null);
  var fila = ler(CHAVES.fila, []);
  var alunos = ler(CHAVES.alunos, {});
  var hoje = ler(CHAVES.hoje, { data: '', itens: [] });

  var video = document.getElementById('video');
  var retorno = document.getElementById('retorno');
  var fluxo = null;
  var detector = null;
  var lendo = false;
  var ultimoCodigo = '';
  var ultimoMomento = 0;
  var enviando = false;
  var canvas = document.createElement('canvas');
  var ctx = canvas.getContext('2d', { willReadFrequently: true });

  // ------------------------------------------------------------ persistencia

  function ler(chave, padrao) {
    try {
      var bruto = localStorage.getItem(chave);
      return bruto ? JSON.parse(bruto) : padrao;
    } catch (e) {
      return padrao;
    }
  }

  function gravar(chave, valor) {
    try {
      localStorage.setItem(chave, JSON.stringify(valor));
    } catch (e) {
      /* armazenamento cheio ou bloqueado: seguimos em memoria */
    }
  }

  function dataDeHoje() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function garantirDia() {
    var atual = dataDeHoje();
    if (hoje.data !== atual) {
      hoje = { data: atual, itens: [] };
      gravar(CHAVES.hoje, hoje);
    }
  }

  // ------------------------------------------------------------------- telas

  function mostrar(id) {
    ['telaConfig', 'telaScanner', 'telaLista'].forEach(function (t) {
      document.getElementById(t).classList.toggle('ativa', t === id);
    });
    if (id === 'telaScanner') iniciarCamera();
    else pararCamera();
    if (id === 'telaLista') desenharLista();
  }

  function atualizarIndicadores() {
    var online = navigator.onLine;
    var pillRede = document.getElementById('pillRede');
    pillRede.textContent = online ? 'online' : 'offline';
    pillRede.className = 'pill ' + (online ? 'on' : 'off');
    document.getElementById('pillFila').textContent = fila.length + ' na fila';
    document.getElementById('numFila').textContent = fila.length;
    document.getElementById('numHoje').textContent = hoje.itens.length;
    document.getElementById('avisoOffline').hidden = online;
  }

  function desenharLista() {
    garantirDia();
    var ul = document.getElementById('listaHoje');
    ul.innerHTML = '';
    if (!hoje.itens.length) {
      var vazio = document.createElement('li');
      vazio.innerHTML = '<span style="color:var(--texto2)">Nenhuma presença registrada hoje.</span>';
      ul.appendChild(vazio);
    }
    hoje.itens.slice().reverse().forEach(function (item) {
      var li = document.createElement('li');
      var nome = document.createElement('span');
      nome.textContent = item.nome || item.codigo;
      var hora = document.createElement('small');
      hora.textContent = item.hora + (item.enviado ? '' : ' · na fila');
      li.appendChild(nome);
      li.appendChild(hora);
      ul.appendChild(li);
    });
    atualizarIndicadores();
  }

  function retornar(classe, nome, msg) {
    retorno.className = classe;
    retorno.innerHTML = '';
    var linha1 = document.createElement('div');
    linha1.className = 'nome';
    linha1.textContent = nome;
    var linha2 = document.createElement('div');
    linha2.className = 'msg';
    linha2.textContent = msg;
    retorno.appendChild(linha1);
    retorno.appendChild(linha2);
  }

  function vibrar(padrao) {
    if (navigator.vibrate) navigator.vibrate(padrao);
  }

  // -------------------------------------------------------------- comunicacao

  function enderecoBase() {
    return (config && config.url ? config.url : '').trim();
  }

  function pedirAlunos(dados) {
    var url = dados.url +
      '?acao=alunos&monitor=' + encodeURIComponent(dados.monitor) +
      '&pin=' + encodeURIComponent(dados.pin);
    return fetch(url, { method: 'GET', redirect: 'follow' })
      .then(function (r) { return r.json(); });
  }

  /* Content-Type text/plain evita o preflight CORS, que o Apps Script nao responde. */
  function enviarLote(registros) {
    return fetch(enderecoBase(), {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        monitor: config.monitor,
        pin: config.pin,
        registros: registros
      })
    }).then(function (r) { return r.json(); });
  }

  function sincronizar() {
    if (enviando || !fila.length || !navigator.onLine || !config) return Promise.resolve();
    enviando = true;
    var lote = fila.slice(0, 50);

    return enviarLote(lote)
      .then(function (resposta) {
        if (!resposta || !resposta.ok) throw new Error((resposta && resposta.erro) || 'falha no envio');
        var idsEnviados = {};
        lote.forEach(function (r) { idsEnviados[r.id] = true; });
        fila = fila.filter(function (r) { return !idsEnviados[r.id]; });
        gravar(CHAVES.fila, fila);

        (resposta.resultados || []).forEach(function (res, i) {
          var original = lote[i];
          hoje.itens.forEach(function (item) {
            if (original && item.id === original.id) {
              item.enviado = true;
              if (res.nome) item.nome = res.nome;
            }
          });
        });
        gravar(CHAVES.hoje, hoje);
      })
      .catch(function () {
        /* fica na fila para a proxima tentativa */
      })
      .then(function () {
        enviando = false;
        atualizarIndicadores();
        if (document.getElementById('telaLista').classList.contains('ativa')) desenharLista();
      });
  }

  // ---------------------------------------------------------------- registro

  function registrar(codigoBruto) {
    garantirDia();
    var codigo = String(codigoBruto || '').trim().toUpperCase();
    if (!codigo) return;

    var agora = Date.now();
    if (codigo === ultimoCodigo && agora - ultimoMomento < 2500) return;
    ultimoCodigo = codigo;
    ultimoMomento = agora;

    var aluno = alunos[codigo];
    if (!aluno) {
      vibrar([80, 60, 80]);
      retornar('erro', 'Código não encontrado', codigo + ' não está na lista de alunos');
      return;
    }

    var jaTem = hoje.itens.some(function (i) { return i.codigo === codigo; });
    if (jaTem) {
      vibrar(40);
      retornar('dup', aluno.nome, 'já registrado hoje');
      return;
    }

    var registro = {
      id: codigo + '-' + agora + '-' + Math.random().toString(36).slice(2, 7),
      codigo: codigo,
      ts: new Date().toISOString(),
      origem: 'qr'
    };
    fila.push(registro);
    gravar(CHAVES.fila, fila);

    hoje.itens.push({
      id: registro.id,
      codigo: codigo,
      nome: aluno.nome,
      hora: new Date().toTimeString().slice(0, 5),
      enviado: false
    });
    gravar(CHAVES.hoje, hoje);

    vibrar(70);
    retornar('ok', aluno.nome, (aluno.turma ? aluno.turma + ' · ' : '') + 'presença registrada');
    atualizarIndicadores();
    sincronizar();
  }

  // ----------------------------------------------------------------- camera

  function iniciarCamera() {
    if (fluxo) return;
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    }).then(function (s) {
      fluxo = s;
      video.srcObject = s;
      return video.play();
    }).then(function () {
      lendo = true;
      if ('BarcodeDetector' in window) {
        try {
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        } catch (e) {
          detector = null;
        }
      }
      requestAnimationFrame(cicloDeLeitura);
    }).catch(function (e) {
      retornar('erro', 'Câmera bloqueada', 'Libere o acesso à câmera nas permissões do navegador');
    });
  }

  function pararCamera() {
    lendo = false;
    if (fluxo) {
      fluxo.getTracks().forEach(function (t) { t.stop(); });
      fluxo = null;
      video.srcObject = null;
    }
  }

  function cicloDeLeitura() {
    if (!lendo) return;
    if (video.readyState !== video.HAVE_ENOUGH_DATA) {
      requestAnimationFrame(cicloDeLeitura);
      return;
    }

    if (detector) {
      detector.detect(video)
        .then(function (codigos) {
          if (codigos && codigos.length) registrar(codigos[0].rawValue);
        })
        .catch(function () { detector = null; })
        .then(function () { if (lendo) setTimeout(cicloDeLeitura, 120); });
      return;
    }

    var largura = 480;
    var altura = Math.round(video.videoHeight * (largura / video.videoWidth)) || 640;
    canvas.width = largura;
    canvas.height = altura;
    ctx.drawImage(video, 0, 0, largura, altura);
    var imagem = ctx.getImageData(0, 0, largura, altura);
    var achado = window.jsQR(imagem.data, largura, altura, { inversionAttempts: 'dontInvert' });
    if (achado && achado.data) registrar(achado.data);
    setTimeout(cicloDeLeitura, 120);
  }

  // ------------------------------------------------------------------ eventos

  document.getElementById('btnEntrar').addEventListener('click', function () {
    var botao = this;
    var erro = document.getElementById('erroConfig');
    var dados = {
      url: document.getElementById('campoUrl').value.trim(),
      monitor: document.getElementById('campoMonitor').value.trim(),
      pin: document.getElementById('campoPin').value.trim()
    };
    if (!dados.url || !dados.monitor || !dados.pin) {
      erro.hidden = false;
      erro.textContent = 'Preencha os três campos.';
      return;
    }
    botao.disabled = true;
    botao.textContent = 'Verificando...';
    erro.hidden = true;

    pedirAlunos(dados).then(function (resposta) {
      if (!resposta || !resposta.ok) throw new Error((resposta && resposta.erro) || 'resposta inválida');
      alunos = {};
      (resposta.alunos || []).forEach(function (a) {
        alunos[String(a.codigo).toUpperCase()] = { nome: a.nome, turma: a.turma };
      });
      config = dados;
      gravar(CHAVES.config, config);
      gravar(CHAVES.alunos, alunos);
      document.getElementById('rodapeMonitor').textContent = config.monitor;
      mostrar('telaScanner');
    }).catch(function (e) {
      erro.hidden = false;
      erro.textContent = 'Não consegui entrar: ' + e.message +
        '. Confira a URL, o nome e o PIN, e se há internet.';
    }).then(function () {
      botao.disabled = false;
      botao.textContent = 'Entrar';
    });
  });

  document.getElementById('btnManual').addEventListener('click', function () {
    var codigo = prompt('Código impresso na carteirinha:');
    if (codigo) registrar(codigo);
  });

  document.getElementById('btnLista').addEventListener('click', function () { mostrar('telaLista'); });
  document.getElementById('btnVoltar').addEventListener('click', function () { mostrar('telaScanner'); });
  document.getElementById('btnSincronizar').addEventListener('click', function () { sincronizar(); });

  document.getElementById('btnSair').addEventListener('click', function (e) {
    e.preventDefault();
    if (fila.length && !confirm('Há ' + fila.length + ' leituras ainda não enviadas. Sair mesmo assim?')) return;
    localStorage.removeItem(CHAVES.config);
    config = null;
    mostrar('telaConfig');
  });

  window.addEventListener('online', function () { atualizarIndicadores(); sincronizar(); });
  window.addEventListener('offline', atualizarIndicadores);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') sincronizar();
    else pararCamera();
  });
  setInterval(sincronizar, 30000);

  // ------------------------------------------------------------------- inicio

  garantirDia();
  atualizarIndicadores();
  if (config) {
    document.getElementById('rodapeMonitor').textContent = config.monitor;
    mostrar('telaScanner');
    sincronizar();
  } else {
    mostrar('telaConfig');
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
