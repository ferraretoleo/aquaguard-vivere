const state = { user:null, locations:[], pools:[], locationId:null, dashboard:null, activeService:null };
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const brDate = value => value ? new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'}).format(new Date(value)).replace(',',' às') : '-';
const liters = value => value ? `${Number(value).toLocaleString('pt-BR')} litros` : 'Volume não informado';

async function api(url, options={}) {
  const response = await fetch(url, { credentials:'same-origin', ...options, headers:{...(options.body instanceof FormData ? {} : {'content-type':'application/json'}), ...(options.headers||{})} });
  if (response.status === 401) { showLogin(); throw new Error('Sessão expirada.'); }
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data.error || data || 'Não foi possível concluir a operação.');
  return data;
}

function toast(message, error=false) {
  const el = $('#toast'); el.textContent = message; el.className = `toast show${error?' error':''}`;
  clearTimeout(toast.timer); toast.timer = setTimeout(()=>el.className='toast',3200);
}

function currentRoute() {
  const name = location.pathname.replace(/^\/+|\/+$/g,'').toLowerCase();
  return ['dashboard','startservice','pools','locations'].includes(name) ? name : 'dashboard';
}

function go(path) {
  history.pushState({},'',path); renderRoute(); closeMenu();
}

function openMenu(){ $('#sidebar').classList.add('open'); $('#overlay').classList.add('show'); }
function closeMenu(){ $('#sidebar').classList.remove('open'); $('#overlay').classList.remove('show'); }

function showLogin() {
  state.user=null; $('#appView').classList.add('hidden'); $('#loginView').classList.remove('hidden');
  if (location.pathname !== '/login') history.replaceState({},'', '/login');
}

async function loadBase() {
  state.locations = await api('/api/locations');
  const saved = localStorage.getItem('aquaguard_location');
  state.locationId = state.user.role==='ADMIN'
    ? (state.locations.some(x=>x.id===saved) ? saved : null)
    : state.locations[0]?.id || state.user.location_id || null;
  const select = $('#locationSelect');
  select.innerHTML = `${state.user.role==='ADMIN'?'<option value="">Todos os locais</option>':''}${state.locations.map(l=>`<option value="${l.id}">${esc(l.name)}</option>`).join('')}`;
  select.value = state.locationId || '';
  state.pools = await api(`/api/pools${state.locationId?`?location_id=${state.locationId}`:''}`);
  await refreshActiveService();
}

function updateActiveServiceAlert(active) {
  state.activeService=active;
  const alert=$('#activeServiceAlert');
  if(!alert)return;
  if(!active){alert.classList.add('hidden');alert.innerHTML='';alert.onclick=null;return;}
  alert.innerHTML=`<span class="active-service-pulse"></span><span><strong>Serviço em andamento</strong><small>${esc(active.pool_name)} · ${esc(active.location_name)}</small><small>Iniciado ${brDate(active.started_at)}</small></span>`;
  alert.classList.remove('hidden');
  alert.onclick=()=>go('/startservice');
}

async function refreshActiveService(){
  const active=await api('/api/maintenances/active');
  updateActiveServiceAlert(active);
  return active;
}

async function showApp() {
  $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden');
  $('#userName').textContent = `${state.user.name} · ${state.user.role==='ADMIN'?'Administrador':'Usuário'}`;
  await loadBase(); renderRoute();
}

async function renderRoute() {
  const route = currentRoute();
  $$('[data-route]').forEach(a=>a.classList.toggle('active',a.dataset.route===route));
  const main = $('#mainContent'); main.innerHTML = '<div class="page"><div class="empty">Carregando...</div></div>';
  try {
    if (route==='dashboard') await renderDashboard();
    if (route==='startservice') await renderService();
    if (route==='pools') await renderPools();
    if (route==='locations') await renderLocations();
  } catch (error) { main.innerHTML=`<div class="page"><div class="empty">${esc(error.message)}</div></div>`; toast(error.message,true); }
}

function linePoints(values, width=760, height=240) {
  const nums=values.map(Number).filter(Number.isFinite); if(!nums.length) return '';
  const min=Math.min(...nums), max=Math.max(...nums), range=max-min||1;
  return values.map((v,i)=>`${30+(i*(width-60)/Math.max(values.length-1,1))},${18+(height-38)*(1-(Number(v)-min)/range)}`).join(' ');
}

function chartSvg(rows) {
  if (!rows.length) return '<div class="empty">Ainda não há medições.</div>';
  const recent=rows.slice(-30), w=760,h=240;
  const ph=recent.map(r=>r.ph), chlorine=recent.map(r=>r.chlorine), alk=recent.map(r=>Number(r.alkalinity)/10), stabilizer=recent.map(r=>Number(r.stabilizer)/10);
  return `<svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Evolução dos parâmetros químicos">
    ${[30,75,120,165,210].map(y=>`<line class="chart-grid" x1="30" x2="730" y1="${y}" y2="${y}"/>`).join('')}
    <polyline class="chart-line" stroke="#2563eb" points="${linePoints(ph,w,h)}"/><polyline class="chart-line" stroke="#16a34a" points="${linePoints(chlorine,w,h)}"/><polyline class="chart-line" stroke="#d97706" points="${linePoints(alk,w,h)}"/><polyline class="chart-line" stroke="#7c3aed" points="${linePoints(stabilizer,w,h)}"/>
  </svg>`;
}

function isIdeal(type,value){ if(value===null||value===undefined||value==='')return false;const n=Number(value);if(type==='ph')return n>=7.2&&n<=7.6;if(type==='chlorine')return n>=1&&n<=3;if(type==='stabilizer')return n>=30&&n<=50;return n>=80&&n<=120; }

function stabilizerStatus(value){
  if(value===null||value===undefined||value==='')return {label:'Não medido',meaning:'Não há medição de estabilizador registrada.',action:'Faça a medição em ppm com fita ou kit reagente.'};
  const n=Number(value);
  if(n<30)return {label:'Ruim (Insuficiente)',meaning:'O cloro fica desprotegido e os raios UV o degradam rapidamente.',action:'Adicione estabilizador puro ou use cloro estabilizado para elevar o nível.'};
  if(n<=50)return {label:'Bom (Ideal)',meaning:'O cloro permanece ativo por mais tempo sob o sol.',action:'Mantenha a rotina atual e meça novamente a cada 2 a 4 semanas.'};
  if(n<60)return {label:'Atenção (Acima do ideal)',meaning:'O nível já está acima da faixa ideal para piscinas com cloro comum.',action:'Evite adicionar mais estabilizador e acompanhe a próxima medição.'};
  if(n<=80)return {label:'Aceitável (Ideal por Sal)',meaning:'É o limite para piscinas comuns e a faixa indicada por fabricantes para piscinas de sal.',action:'Em piscina de sal, mantenha. Com cloro comum, suspenda pastilhas e use cloro não estabilizado temporariamente.'};
  if(n<=100)return {label:'Alto (Atenção)',meaning:'O nível se aproxima da faixa de bloqueio do cloro.',action:'Não adicione estabilizador e planeje reduzir o nível por diluição.'};
  return {label:'Excesso (Bloqueio)',meaning:'A sobre-estabilização reduz a ação do cloro e pode deixar a água turva ou com algas.',action:'Drene parcialmente, em geral de 30% a 50%, e complete com água limpa.'};
}

async function renderDashboard(poolId='') {
  const query=new URLSearchParams(); if(state.locationId)query.set('location_id',state.locationId); if(poolId)query.set('pool_id',poolId);
  state.dashboard=await api(`/api/dashboard?${query}`);
  const d=state.dashboard, location=state.locations.find(x=>x.id===state.locationId);
  $('#mainContent').innerHTML=`<div class="page">
    <div class="page-head"><div><h1>🏊 Sistema de Controle de Piscinas</h1><p>${esc(location?.name||'Todos os locais')}</p></div><button class="btn primary" data-go="/startservice">＋ Iniciar Serviço</button></div>
    <section class="stats"><div class="stat-card"><span>Piscinas Ativas</span><strong>${d.stats.activePools}</strong></div><div class="stat-card"><span>Manutenções Hoje</span><strong>${d.stats.today}</strong></div><div class="stat-card"><span>Total de Registros</span><strong>${d.stats.total}</strong></div></section>
    <section class="dashboard-grid"><div class="panel"><div class="panel-title"><h2>Evolução dos Parâmetros Químicos</h2><select id="chartPool" class="select"><option value="">Todas as Piscinas</option>${state.pools.filter(p=>p.is_active).map(p=>`<option value="${p.id}" ${p.id===poolId?'selected':''}>${esc(p.name)}</option>`).join('')}</select></div><div class="chart-wrap">${chartSvg(d.trends)}</div><div class="legend"><span><i style="background:#2563eb"></i>pH</span><span><i style="background:#16a34a"></i>Cloro</span><span><i style="background:#d97706"></i>Alcalinidade (÷10)</span><span><i style="background:#7c3aed"></i>Estabilizador (÷10)</span></div></div>
    <div class="panel report-box"><div class="panel-title"><h3>Enviar Relatório de Evolução Química</h3></div><label>Selecione a Piscina</label><select id="reportPool" class="select"><option value="">Escolha uma piscina</option>${state.pools.filter(p=>p.is_active).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select><button id="sendEvolution" class="btn primary full" disabled>✉ Enviar Relatório por Email</button></div></section>
    <section class="history"><h2>Histórico de Manutenções</h2><div class="history-list">${d.history.length?d.history.map(historyCard).join(''):'<div class="panel empty">Nenhuma manutenção encontrada.</div>'}</div></section>
  </div>`;
  bindRoutes();
  $('#chartPool').onchange=e=>renderDashboard(e.target.value);
  $('#reportPool').onchange=e=>$('#sendEvolution').disabled=!e.target.value;
  $('#sendEvolution').onclick=async()=>{const id=$('#reportPool').value;try{$('#sendEvolution').disabled=true;await api('/api/reports/evolution/email',{method:'POST',body:JSON.stringify({pool_id:id})});toast('Relatório enviado para os e-mails cadastrados.');}catch(e){toast(e.message,true);}finally{$('#sendEvolution').disabled=false;}};
  $$('.history-open').forEach(b=>b.onclick=()=>openMaintenance(b.dataset.id));
}

function historyCard(m) {
  return `<article class="history-card"><div><h3>${esc(m.pool_name)} - ${esc(m.location_name)}</h3><p>${esc(m.executor)}</p><p>${brDate(m.started_at)}</p></div><div><div class="chips"><span class="chip ${isIdeal('ph',m.ph)?'good':''}">pH: ${esc(m.ph)}</span><span class="chip ${isIdeal('chlorine',m.chlorine)?'good':''}">Cloro: ${esc(m.chlorine)}</span><span class="chip ${isIdeal('alk',m.alkalinity)?'good':''}">Alc: ${esc(m.alkalinity)}</span><span class="chip ${isIdeal('stabilizer',m.stabilizer)?'good':''}">Estab: ${esc(m.stabilizer??'-')} ppm</span></div><p>${(m.services||[]).length} serviço(s) realizado(s)</p></div><button class="history-open" data-id="${m.id}" title="Ver detalhes">⌕</button></article>`;
}

function canvasBlob(canvas){
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Não foi possível criar a imagem.')),'image/png'));
}

async function createMaintenanceImage(m){
  if(typeof html2canvas!=='function')throw new Error('O gerador de imagem não foi carregado.');
  const modal=$('.modal');
  if(!modal)throw new Error('Os detalhes da manutenção não estão abertos.');
  const host=document.createElement('div');
  host.className='share-render-host';
  const clone=modal.cloneNode(true);
  clone.classList.add('share-render-card');
  clone.querySelectorAll('[data-html2canvas-ignore]').forEach(el=>el.remove());
  host.appendChild(clone);
  document.body.appendChild(host);
  try{
    if(document.fonts?.ready)await document.fonts.ready;
    const canvas=await html2canvas(clone,{backgroundColor:'#ffffff',scale:2,useCORS:true,logging:false,windowWidth:700});
    const blob=await canvasBlob(canvas);
    const safeName=String(m.pool_name||'piscina').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').toLowerCase();
    return {blob,file:new File([blob],`manutencao-${safeName}.png`,{type:'image/png'})};
  }finally{host.remove();}
}

async function shareMaintenanceImage(m,imagePromise){
  const button=$('#copyWhats');
  try{
    if(button){button.disabled=true;button.textContent='Gerando imagem...';}
    const generated=await imagePromise;
    if(generated.error)throw generated.error;
    const {blob,file}=generated;
    if(navigator.clipboard?.write&&window.ClipboardItem){
      try{
        await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
        toast('Imagem copiada. Agora é só colar no WhatsApp.');
        return;
      }catch{}
    }
    if(navigator.share&&navigator.canShare?.({files:[file]})){
      try{
        await navigator.share({title:'Detalhes da manutenção',text:`Manutenção da ${m.pool_name}`,files:[file]});
        return;
      }catch(error){if(error.name==='AbortError')return;}
    }
    const link=document.createElement('a');
    link.href=URL.createObjectURL(blob);link.download=file.name;link.click();
    setTimeout(()=>URL.revokeObjectURL(link.href),1000);
    toast('A imagem foi baixada para você enviar no WhatsApp.');
  }catch(error){
    try{await navigator.clipboard.writeText(m.whatsapp_text);toast('O navegador não permitiu copiar a imagem. O texto foi copiado.',true);}
    catch{toast(error.message||'Não foi possível gerar a imagem.',true);}
  }finally{
    if(button){button.disabled=false;button.textContent='Copiar para WhatsApp';}
  }
}

async function openMaintenance(id) {
  try {
    const m=await api(`/api/maintenances/${id}`);
    const cya=stabilizerStatus(m.stabilizer);
    openModal('Detalhes da Manutenção',`<div class="detail-grid"><div class="detail"><span>Piscina</span><strong>${esc(m.pool_name)} - ${esc(m.location_name)}</strong></div><div class="detail"><span>Executante</span><strong>${esc(m.executor)}</strong></div><div class="detail"><span>Data/Hora Início</span><strong>${brDate(m.started_at)}</strong></div><div class="detail"><span>Data/Hora Término</span><strong>${brDate(m.ended_at)}</strong></div></div>
      <h3>Medições Químicas</h3><div class="measurements"><div class="measure"><span>pH</span><strong>${esc(m.ph)}</strong><small>${isIdeal('ph',m.ph)?'✓ Ideal':'⚠ Verificar'} · Ref. 7,2 a 7,6</small></div><div class="measure"><span>Cloro Livre</span><strong>${esc(m.chlorine)}</strong><small>${isIdeal('chlorine',m.chlorine)?'✓ Ideal':'⚠ Verificar'} · Ref. 1 a 3 ppm</small></div><div class="measure"><span>Alcalinidade</span><strong>${esc(m.alkalinity)}</strong><small>${isIdeal('alk',m.alkalinity)?'✓ Ideal':'⚠ Verificar'} · Ref. 80 a 120 ppm</small></div><div class="measure"><span>Estabilizador (CYA)</span><strong>${esc(m.stabilizer??'-')} ppm</strong><small>${esc(cya.label)} · Ref. 30 a 50 ppm</small></div></div>
      <div class="info"><strong>${esc(cya.label)}</strong><br>${esc(cya.meaning)}<br><strong>O que fazer:</strong> ${esc(cya.action)}</div>
      <h3>Serviços Executados</h3><div class="chips">${(m.services||[]).map(s=>`<span class="chip good">✓ ${esc(s)}</span>`).join('')||'-'}</div>${m.notes?`<h3>Observações</h3><p>${esc(m.notes)}</p>`:''}
      <div class="form-actions" data-html2canvas-ignore><a class="btn outline" href="/api/maintenances/${m.id}/report.pdf">Gerar Relatório</a><button id="copyWhats" class="btn primary">Copiar para WhatsApp</button></div>`);
    const imagePromise=createMaintenanceImage(m).catch(error=>({error}));
    $('#copyWhats').onclick=()=>shareMaintenanceImage(m,imagePromise);
  } catch(e){toast(e.message,true);}
}

async function renderService() {
  const active=await api('/api/maintenances/active');
  updateActiveServiceAlert(active);
  const now=brDate(new Date());
  $('#mainContent').innerHTML=`<div class="page"><button class="btn outline back-button" data-go="/dashboard">← Voltar</button><div class="page-head"><div><h1>${active?'Finalizar Serviço':'Iniciar Serviço'}</h1><p>${now}</p></div></div>
    <form id="serviceForm" class="form-card" enctype="multipart/form-data">${active?completeServiceForm(active):startServiceForm()}</form></div>`;
  bindRoutes();
  $('#serviceForm').onsubmit=active?e=>completeService(e,active.id):startService;
}

function startServiceForm(){return `<div class="form-section"><h3>Informações Básicas</h3><div class="form-grid"><div class="field"><span>Piscina *</span><select name="pool_id" required><option value="">Selecione a piscina</option>${state.pools.filter(p=>p.is_active).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div><div class="field"><span>Nome do Executante *</span><input name="executor" placeholder="Digite seu nome" required></div></div></div><div class="form-section"><h3>Fotos do Início (Opcional)</h3><div class="field"><input name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple><small>Até 5 fotos, com no máximo 6 MB cada.</small></div></div><div class="info">Após iniciar o serviço, você poderá retornar ao app para registrar o fechamento com as medições e serviços executados.</div><div class="form-actions"><button class="btn primary" type="submit">Iniciar Serviço</button></div>`;}

function completeServiceForm(m){return `<div class="info">Serviço iniciado em ${brDate(m.started_at)} por ${esc(m.executor)} na ${esc(m.pool_name)}.</div><div class="form-section"><h3>Medições Químicas</h3><div class="form-grid"><div class="field"><span>pH *</span><input name="ph" type="number" min="0" max="14" step="0.1" required><small class="chemical-reference">Referência ideal: 7,2 a 7,6</small></div><div class="field"><span>Cloro Livre (ppm) *</span><input name="chlorine" type="number" min="0" step="0.1" required><small class="chemical-reference">Referência ideal: 1 a 3 ppm</small></div><div class="field"><span>Alcalinidade (ppm) *</span><input name="alkalinity" type="number" min="0" step="1" required><small class="chemical-reference">Referência ideal: 80 a 120 ppm</small></div><div class="field"><span>Estabilizador / Ácido Cianúrico (ppm) *</span><input name="stabilizer" type="number" min="0" step="1" required><small class="chemical-reference">Ideal: 30 a 50 ppm · Piscina de sal: 60 a 80 ppm</small></div></div></div><div class="form-section"><h3>Serviços Executados</h3><div class="checkboxes">${['Limpeza Superficial','Aspiração','Limpeza de Borda','Retrolavagem do Filtro','Tratamento Químico','Verificação dos Equipamentos'].map(s=>`<label class="check"><input type="checkbox" name="services" value="${s}">${s}</label>`).join('')}</div></div><div class="form-section"><div class="field"><span>Observações</span><textarea name="notes" placeholder="Informe ocorrências, produtos aplicados ou recomendações"></textarea></div></div><div class="form-section"><h3>Fotos do Término (Opcional)</h3><div class="field"><input name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple></div></div><div class="form-actions"><button class="btn primary" type="submit">Finalizar Serviço</button></div>`;}

async function startService(e){e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button[type=submit]');try{btn.disabled=true;await api('/api/maintenances/start',{method:'POST',body:new FormData(form)});await refreshActiveService();toast('Serviço iniciado.');renderService();}catch(err){toast(err.message,true);}finally{btn.disabled=false;}}
async function completeService(e,id){e.preventDefault();const form=e.currentTarget,fd=new FormData(form),btn=form.querySelector('button[type=submit]');fd.set('services',JSON.stringify($$('input[name=services]:checked',form).map(i=>i.value)));try{btn.disabled=true;await api(`/api/maintenances/${id}/complete`,{method:'POST',body:fd});await refreshActiveService();toast('Serviço finalizado com sucesso.');go('/dashboard');}catch(err){toast(err.message,true);}finally{btn.disabled=false;}}

async function renderPools(){ state.pools=await api(`/api/pools${state.locationId?`?location_id=${state.locationId}`:''}`);$('#mainContent').innerHTML=`<div class="page"><button class="btn outline back-button" data-go="/dashboard">← Voltar</button><div class="page-head"><div><h1>Gerenciar Piscinas</h1><p>Cadastre e gerencie as piscinas do condomínio</p></div>${state.user.role==='ADMIN'?'<button id="newPool" class="btn primary">＋ Nova Piscina</button>':''}</div><div class="cards-list">${state.pools.map(poolCard).join('')||'<div class="panel empty">Nenhuma piscina cadastrada.</div>'}</div></div>`;bindRoutes();if($('#newPool'))$('#newPool').onclick=()=>poolModal();$$('[data-edit-pool]').forEach(b=>b.onclick=()=>poolModal(state.pools.find(p=>p.id===b.dataset.editPool)));$$('[data-disable-pool]').forEach(b=>b.onclick=()=>disablePool(b.dataset.disablePool));}
function poolCard(p){return `<article class="item-card"><div class="item-main"><h3>${esc(p.name)} - ${esc(p.location_name)}</h3><div class="item-meta"><span class="badge ${p.is_active?'':'off'}">${p.is_active?'Ativa':'Inativa'}</span><span>${esc(p.pool_location||'Local não informado')}</span><span>${liters(p.volume_liters)}</span></div></div>${state.user.role==='ADMIN'?`<div class="actions"><button class="btn outline" data-edit-pool="${p.id}">Editar</button><button class="btn danger" data-disable-pool="${p.id}">Desativar</button></div>`:''}</article>`;}
function poolModal(p=null){openModal(p?'Editar Piscina':'Nova Piscina',`<form id="poolForm"><div class="form-grid"><div class="field full-row"><span>Local *</span><select name="location_id" required>${state.locations.map(l=>`<option value="${l.id}" ${l.id===(p?.location_id||state.locationId)?'selected':''}>${esc(l.name)}</option>`).join('')}</select></div><div class="field full-row"><span>Nome da Piscina *</span><input name="name" value="${esc(p?.name||'')}" placeholder="Ex: Piscina Principal" required></div><div class="field"><span>Localização</span><input name="pool_location" value="${esc(p?.pool_location||'')}" placeholder="Ex: Área de Lazer 1"></div><div class="field"><span>Volume (litros)</span><input name="volume_liters" type="number" min="0" value="${esc(p?.volume_liters||'')}"></div><div class="field"><span>Status</span><select name="is_active"><option value="true" ${p?.is_active!==false?'selected':''}>Ativa</option><option value="false" ${p?.is_active===false?'selected':''}>Inativa</option></select></div></div><div class="form-actions"><button type="button" class="btn outline" data-close-modal>Cancelar</button><button class="btn primary" type="submit">${p?'Salvar':'Criar'}</button></div></form>`);$('#poolForm').onsubmit=async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.currentTarget));values.is_active=values.is_active==='true';values.volume_liters=values.volume_liters?Number(values.volume_liters):null;try{await api(p?`/api/pools/${p.id}`:'/api/pools',{method:p?'PUT':'POST',body:JSON.stringify(values)});closeModal();toast(`Piscina ${p?'atualizada':'criada'}.`);renderPools();}catch(err){toast(err.message,true);}};}
async function disablePool(id){if(!confirm('Deseja desativar esta piscina? O histórico será preservado.'))return;try{await api(`/api/pools/${id}`,{method:'DELETE'});toast('Piscina desativada.');renderPools();}catch(e){toast(e.message,true);}}

async function renderLocations(){state.locations=await api('/api/locations');$('#mainContent').innerHTML=`<div class="page"><button class="btn outline back-button" data-go="/dashboard">← Voltar</button><div class="page-head"><div><h1>Gerenciar Locais</h1><p>Cadastre os prédios e condomínios</p></div>${state.user.role==='ADMIN'?'<button id="newLocation" class="btn primary">＋ Novo Local</button>':''}</div><div class="cards-list">${state.locations.map(locationCard).join('')||'<div class="panel empty">Nenhum local cadastrado.</div>'}</div></div>`;bindRoutes();if($('#newLocation'))$('#newLocation').onclick=()=>locationModal();$$('[data-edit-location]').forEach(b=>b.onclick=()=>locationModal(state.locations.find(l=>l.id===b.dataset.editLocation)));$$('[data-disable-location]').forEach(b=>b.onclick=()=>disableLocation(b.dataset.disableLocation));}
function locationCard(l){return `<article class="item-card"><div class="item-main"><h3>${esc(l.name)}</h3><div class="item-meta"><span class="badge ${l.is_active?'':'off'}">${l.is_active?'Ativo':'Inativo'}</span><span>${esc(l.address||'Endereço não informado')}</span></div><div class="item-meta" style="margin-top:8px"><strong>Emails para relatórios:</strong> ${(l.report_emails||[]).map(esc).join(' • ')||'Nenhum'}</div></div>${state.user.role==='ADMIN'?`<div class="actions"><button class="btn outline" data-edit-location="${l.id}">Editar</button><button class="btn danger" data-disable-location="${l.id}">Desativar</button></div>`:''}</article>`;}
function locationModal(l=null){openModal(l?'Editar Local':'Novo Local',`<form id="locationForm"><div class="form-grid"><div class="field full-row"><span>Nome do Local *</span><input name="name" value="${esc(l?.name||'')}" placeholder="Ex: Vivere Palhano" required></div><div class="field full-row"><span>Endereço</span><input name="address" value="${esc(l?.address||'')}" placeholder="Ex: Rua ABC, 123"></div><div class="field full-row"><span>Emails para Relatórios</span><textarea name="report_emails" placeholder="Um e-mail por linha">${esc((l?.report_emails||[]).join('\n'))}</textarea></div><div class="field"><span>Status</span><select name="is_active"><option value="true" ${l?.is_active!==false?'selected':''}>Ativo</option><option value="false" ${l?.is_active===false?'selected':''}>Inativo</option></select></div></div><div class="form-actions"><button type="button" class="btn outline" data-close-modal>Cancelar</button><button class="btn primary" type="submit">${l?'Salvar':'Criar'}</button></div></form>`);$('#locationForm').onsubmit=async e=>{e.preventDefault();const v=Object.fromEntries(new FormData(e.currentTarget));v.is_active=v.is_active==='true';try{await api(l?`/api/locations/${l.id}`:'/api/locations',{method:l?'PUT':'POST',body:JSON.stringify(v)});closeModal();toast(`Local ${l?'atualizado':'criado'}.`);await loadBase();renderLocations();}catch(err){toast(err.message,true);}};}
async function disableLocation(id){if(!confirm('Deseja desativar este local? Os dados e o histórico serão preservados.'))return;try{await api(`/api/locations/${id}`,{method:'DELETE'});toast('Local desativado.');await loadBase();renderLocations();}catch(e){toast(e.message,true);}}

function openModal(title,body){$('#modalRoot').innerHTML=`<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>${esc(title)}</h2><button class="modal-close" data-close-modal data-html2canvas-ignore aria-label="Fechar">×</button></div><div class="modal-body">${body}</div></section></div>`;$$('[data-close-modal]').forEach(b=>b.onclick=closeModal);$('.modal-backdrop').onclick=e=>{if(e.target===e.currentTarget)closeModal();};}
function closeModal(){$('#modalRoot').innerHTML='';}
function bindRoutes(){$$('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));}

document.addEventListener('DOMContentLoaded',async()=>{
  $$('[data-route]').forEach(a=>a.onclick=e=>{e.preventDefault();go(a.getAttribute('href'));});
  $('#openMenu').onclick=openMenu;$('#closeMenu').onclick=closeMenu;$('#overlay').onclick=closeMenu;
  $('#locationSelect').onchange=async e=>{state.locationId=e.target.value||null;localStorage.setItem('aquaguard_location',state.locationId||'__all__');state.pools=await api(`/api/pools${state.locationId?`?location_id=${state.locationId}`:''}`);renderRoute();};
  $('#logoutButton').onclick=async()=>{await api('/api/auth/logout',{method:'POST'});showLogin();};
  $('#loginForm').onsubmit=async e=>{e.preventDefault();const b=e.currentTarget.querySelector('button');try{b.disabled=true;const v=Object.fromEntries(new FormData(e.currentTarget));const r=await api('/api/auth/login',{method:'POST',body:JSON.stringify(v)});state.user=r.user;const next=new URLSearchParams(location.search).get('from');if(next==='/usuarios'){location.href='/usuarios';return;}history.replaceState({},'', '/dashboard');await showApp();}catch(err){toast(err.message,true);}finally{b.disabled=false;}};
  addEventListener('popstate',()=>state.user?renderRoute():showLogin());
  addEventListener('visibilitychange',()=>{if(!document.hidden&&state.user)refreshActiveService().catch(()=>{});});
  setInterval(()=>{if(state.user)refreshActiveService().catch(()=>{});},30000);
  try{const config=await api('/api/config');if(config.googleEnabled){$('#googleLogin').classList.remove('hidden');$('#loginDivider').classList.remove('hidden');}}catch{}
  try{const me=await api('/api/me');state.user=me.user;if(location.pathname==='/login')history.replaceState({},'', '/dashboard');await showApp();}catch{showLogin();}
});
