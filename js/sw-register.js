if("serviceWorker" in navigator){
  navigator.serviceWorker.register("./sw.js").then(reg=>{
    if(!reg) return;
    // força verificação de atualização a cada carregamento
    reg.update();
    reg.addEventListener('updatefound',()=>{
      const nw=reg.installing;
      if(!nw) return;
      nw.addEventListener('statechange',()=>{
        if(nw.state==='installed' && navigator.serviceWorker.controller){
          // nova versão pronta — recarrega uma única vez (evita loop de reload)
          // e não interrompe o usuário no meio de uma edição
          let recarregou = false;
          navigator.serviceWorker.addEventListener('controllerchange',()=>{
            if(recarregou) return; recarregou = true;
            if(document.querySelector('.sheet.open')){
              toast('Nova versão pronta — será aplicada ao fechar');
              const iv = setInterval(()=>{ if(!document.querySelector('.sheet.open')){ clearInterval(iv); location.reload(); } }, 800);
            } else location.reload();
          });
          nw.postMessage({type:'SKIP_WAITING'});
        }
      });
    });
  });
}
