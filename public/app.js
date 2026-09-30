const state = { user:null, locations:[], pools:[], paymentPlans:[], locationId:null, dashboard:null, activeService:null };
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const brDate = value => value ? new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'}).format(new Date(value)).replace(',',' às') : '-';
const liters = value => value ? `${Number(value).toLocaleString('pt-BR')} litros` : 'Volume não informado';
const isGeneralAdmin = () => state.user?.role==='ADMIN';
const isLocalAdmin = () => state.user?.role==='LOCAL_ADMIN';
const canManageLocalData = () => isGeneralAdmin() || isLocalAdmin();
const roleLabel = role => ({ADMIN:'Administrador geral',LOCAL_ADMIN:'Administrador local',USER:'Usuário'}[role]||role);

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
  return ['dashboard','startservice','pools','locations','paymentplans','itineraries','reports'].includes(name) ? name : 'dashboard';
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
  state.locationId = state.locations.some(x=>x.id===saved)
    ? saved
    : (isGeneralAdmin() ? null : state.locations[0]?.id || null);
  const select = $('#locationSelect');
  select.innerHTML = `${isGeneralAdmin()?'<option value="">Todos os locais</option>':''}${state.locations.map(l=>`<option value="${l.id}">${esc(l.name)}</option>`).join('')}`;
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
  $('#userName').textContent = `${state.user.name} · ${roleLabel(state.user.role)}`;
  $$('[data-manage-local]').forEach(item=>item.classList.toggle('hidden',!canManageLocalData()));
  await loadBase(); renderRoute();
}

async function renderRoute() {
  let route = currentRoute();
  if (['pools','locations','paymentplans'].includes(route) && !canManageLocalData()) {
    route='dashboard';
    history.replaceState({},'', '/dashboard');
  }
  $$('[data-route]').forEach(a=>a.classList.toggle('active',a.dataset.route===route));
  const main = $('#mainContent'); main.innerHTML = '<div class="page"><div class="empty">Carregando...</div></div>';
  try {
    if (route==='dashboard') await renderDashboard();
    if (route==='startservice') await renderService();
    if (route==='pools') await renderPools();
    if (route==='locations') await renderLocations();
    if (route==='paymentplans') await renderPaymentPlans();
    if (route==='itineraries') new URLSearchParams(location.search).get('view')==='report' ? await renderItineraryReport() : await renderItineraries();
    if (route==='reports') await renderReports();
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
  const [dashboard,itineraries]=await Promise.all([api(`/api/dashboard?${query}`),api(`/api/itineraries?date_from=${brazilInputDate()}&only_open=true&limit=6`)]);
  state.dashboard=dashboard;
  const d=state.dashboard, location=state.locations.find(x=>x.id===state.locationId);
  $('#mainContent').innerHTML=`<div class="page">
    <div class="page-head"><div><h1>🏊 Sistema de Controle de Piscinas</h1><p>${esc(location?.name||'Todos os locais')}</p></div><button class="btn primary" data-go="/startservice">＋ Iniciar Serviço</button></div>
    <section class="stats"><div class="stat-card"><span>Piscinas Ativas</span><strong>${d.stats.activePools}</strong></div><div class="stat-card"><span>Manutenções Hoje</span><strong>${d.stats.today}</strong></div><div class="stat-card"><span>Total de Registros</span><strong>${d.stats.total}</strong></div></section>
    <section class="dashboard-main-row"><div class="panel dashboard-chart"><div class="panel-title"><h2>Evolução dos Parâmetros Químicos</h2><select id="chartPool" class="select"><option value="">Todas as Piscinas</option>${state.pools.filter(p=>p.is_active).map(p=>`<option value="${p.id}" ${p.id===poolId?'selected':''}>${esc(p.name)}</option>`).join('')}</select></div><div class="chart-wrap">${chartSvg(d.trends)}</div><div class="legend"><span><i style="background:#2563eb"></i>pH</span><span><i style="background:#16a34a"></i>Cloro</span><span><i style="background:#d97706"></i>Alcalinidade (÷10)</span><span><i style="background:#7c3aed"></i>Estabilizador (÷10)</span></div></div><aside class="panel dashboard-itineraries"><div class="panel-title"><div><h2>Itinerários</h2><small>Hoje e próximos dias</small></div><div class="dashboard-itinerary-actions"><button id="dashboardNewItinerary" class="btn primary dashboard-new-itinerary">＋ Novo</button><button class="btn secondary dashboard-new-itinerary" data-go="/itineraries">Abrir menu</button></div></div><div class="dashboard-itinerary-list">${itineraries.length?itineraries.map(dashboardItineraryCard).join(''):'<div class="empty">Nenhum itinerário programado.</div>'}</div></aside></section>
    <section class="history"><h2>Histórico de Manutenções</h2><div class="history-columns"><div class="history-column"><h3>Manutenções</h3><div class="history-list">${d.history.length?d.history.map(historyCard).join(''):'<div class="panel empty">Nenhuma manutenção encontrada.</div>'}</div></div><div class="history-column problems-column"><h3>Problemas detectados</h3><div class="history-list">${d.problems?.length?d.problems.map(problemCard).join(''):'<div class="panel empty">Nenhum problema detectado.</div>'}</div></div></div></section>
  </div>`;
  bindRoutes();
  $('#chartPool').onchange=e=>renderDashboard(e.target.value);
  $('#dashboardNewItinerary').onclick=()=>itineraryFormModal();
  $$('[data-dashboard-itinerary]').forEach(b=>b.onclick=()=>openItinerary(b.dataset.dashboardItinerary));
  $$('.history-open').forEach(b=>b.onclick=()=>openMaintenance(b.dataset.id));
}

function dashboardItineraryCard(item){const status=itineraryStatus(item);return `<button type="button" class="dashboard-itinerary-card" data-dashboard-itinerary="${item.id}"><div class="itinerary-title-line"><strong>${esc(item.title)}</strong><span class="badge ${status==='Concluído'?'':status==='Em andamento'?'progress':'off'}">${status}</span></div><span class="dashboard-itinerary-date">📅 ${dateOnlyBr(item.service_date)}</span>${canManageLocalData()?`<span class="dashboard-itinerary-user">👤 ${esc(item.responsible_name)}</span>`:''}<span class="dashboard-itinerary-progress"><i style="width:${item.total_stops?Math.round(Number(item.visited_stops)*100/Number(item.total_stops)):0}%"></i></span><small>${item.visited_stops}/${item.total_stops} locais visitados</small></button>`;}

function historyCard(m) {
  return `<article class="history-card"><div><h3>${esc(m.pool_name)} - ${esc(m.location_name)}</h3><p>${esc(m.executor)}</p><p>${brDate(m.started_at)}</p><div class="chips"><span class="chip ${isIdeal('ph',m.ph)?'good':''}">pH: ${esc(m.ph)}</span><span class="chip ${isIdeal('chlorine',m.chlorine)?'good':''}">Cloro: ${esc(m.chlorine)}</span><span class="chip ${isIdeal('alk',m.alkalinity)?'good':''}">Alc: ${esc(m.alkalinity)}</span><span class="chip ${isIdeal('stabilizer',m.stabilizer)?'good':''}">Estab: ${esc(m.stabilizer??'-')} ppm</span></div><p>${(m.services||[]).length} serviço(s) realizado(s)</p></div><button class="history-open" data-id="${m.id}" title="Ver detalhes">⌕</button></article>`;
}

function problemCard(m) {
  return `<article class="history-card problem-card"><div><h3>${esc(m.pool_name)} - ${esc(m.location_name)}</h3><p>${esc(m.executor)} · ${brDate(m.started_at)}</p><p class="problem-text">${esc(m.problems_found)}</p></div><button class="history-open" data-id="${m.id}" title="Ver detalhes">⌕</button></article>`;
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
      <h3>Serviços Executados</h3><div class="chips">${(m.services||[]).map(s=>`<span class="chip good">✓ ${esc(s)}</span>`).join('')||'-'}</div>${m.problems_found?`<h3>Problemas encontrados</h3><div class="problem-detail">${esc(m.problems_found)}</div>`:''}${m.notes?`<h3>Observações</h3><p>${esc(m.notes)}</p>`:''}
      <div class="form-actions" data-html2canvas-ignore><a class="btn outline" href="/api/maintenances/${m.id}/report.pdf">Gerar Relatório</a>${m.quote_total!==null&&m.quote_total!==undefined?`<a class="btn secondary" href="/api/maintenances/${m.id}/quote.pdf" target="_blank">Imprimir Orçamento</a>`:''}<button id="copyWhats" class="btn primary">Copiar para WhatsApp</button></div>`);
    const imagePromise=createMaintenanceImage(m).catch(error=>({error}));
    $('#copyWhats').onclick=()=>shareMaintenanceImage(m,imagePromise);
  } catch(e){toast(e.message,true);}
}

async function renderService() {
  const active=await api('/api/maintenances/active');
  updateActiveServiceAlert(active);
  const query=new URLSearchParams(location.search);
  const itineraryStopId=!active?query.get('itinerary_stop_id')||'':'';
  const itineraryLocationId=!active?query.get('location_id')||'':'';
  if(itineraryLocationId&&state.locationId!==itineraryLocationId){state.locationId=itineraryLocationId;localStorage.setItem('aquaguard_location',itineraryLocationId);$('#locationSelect').value=itineraryLocationId;state.pools=await api(`/api/pools?location_id=${encodeURIComponent(itineraryLocationId)}`);}
  const now=brDate(new Date());
  $('#mainContent').innerHTML=`<div class="page"><button class="btn outline back-button" data-go="/dashboard">← Voltar</button><div class="page-head"><div><h1>${active?'Finalizar Serviço':'Iniciar Serviço'}</h1><p>${now}</p></div></div>
    <form id="serviceForm" class="form-card" enctype="multipart/form-data">${active?completeServiceForm(active):startServiceForm(itineraryStopId)}</form></div>`;
  bindRoutes();
  if(active)bindQuoteForm();
  $('#serviceForm').onsubmit=active?e=>completeService(e,active.id):startService;
}

function startServiceForm(itineraryStopId=''){return `${itineraryStopId?`<input type="hidden" name="itinerary_stop_id" value="${esc(itineraryStopId)}"><div class="info itinerary-service-info">Este serviço será vinculado automaticamente à parada selecionada no itinerário.</div>`:''}<div class="form-section"><h3>Informações Básicas</h3><div class="form-grid"><div class="field"><span>Piscina *</span><select name="pool_id" required><option value="">Selecione a piscina</option>${state.pools.filter(p=>p.is_active).map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div><div class="field"><span>Nome do Executante *</span><input name="executor" value="${esc(state.user?.name||'')}" placeholder="Digite seu nome" required></div></div></div><div class="form-section"><h3>Fotos do Início (Opcional)</h3><div class="field"><input name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple><small>Até 5 fotos, com no máximo 6 MB cada.</small></div></div><div class="info">Após iniciar o serviço, você poderá retornar ao app para registrar o fechamento com as medições e serviços executados.</div><div class="form-actions"><button class="btn primary" type="submit">Iniciar Serviço</button></div>`;}

function completeServiceForm(m){return `<div class="info">Serviço iniciado em ${brDate(m.started_at)} por ${esc(m.executor)} na ${esc(m.pool_name)}.</div><div class="form-section"><h3>Medições Químicas</h3><div class="form-grid"><div class="field"><span>pH *</span><input name="ph" type="number" min="0" max="14" step="0.1" required><small class="chemical-reference">Referência ideal: 7,2 a 7,6</small></div><div class="field"><span>Cloro Livre (ppm) *</span><input name="chlorine" type="number" min="0" step="0.1" required><small class="chemical-reference">Referência ideal: 1 a 3 ppm</small></div><div class="field"><span>Alcalinidade (ppm) *</span><input name="alkalinity" type="number" min="0" step="1" required><small class="chemical-reference">Referência ideal: 80 a 120 ppm</small></div><div class="field"><span>Estabilizador / Ácido Cianúrico (ppm) *</span><input name="stabilizer" type="number" min="0" step="1" required><small class="chemical-reference">Ideal: 30 a 50 ppm · Piscina de sal: 60 a 80 ppm</small></div></div></div><div class="form-section"><h3>Serviços Executados</h3><div class="checkboxes">${['Limpeza Superficial','Aspiração','Limpeza de Borda','Retrolavagem do Filtro','Tratamento Químico','Verificação dos Equipamentos'].map(s=>`<label class="check"><input type="checkbox" name="services" value="${s}">${s}</label>`).join('')}</div></div><div class="form-section"><div class="field"><span>Problemas encontrados</span><textarea name="problems_found" id="problemsFound" placeholder="Descreva os problemas identificados durante o serviço"></textarea></div><label class="check quote-toggle"><input type="checkbox" name="generate_quote" id="generateQuote" disabled> Gerar orçamento para este problema</label><div id="quoteSection" class="quote-section hidden"><div class="quote-head"><div><h3>Itens do orçamento</h3><small>Informe a descrição e o valor de cada item.</small></div><button type="button" class="btn secondary" id="addQuoteItem">＋ Adicionar item</button></div><div id="quoteItems" class="quote-items"></div><div class="quote-total"><span>Valor total</span><strong id="quoteTotal">R$ 0,00</strong></div></div></div><div class="form-section"><div class="field"><span>Observações</span><textarea name="notes" placeholder="Informe ocorrências, produtos aplicados ou recomendações"></textarea></div></div><div class="form-section"><h3>Fotos do Término (Opcional)</h3><div class="field"><input name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple></div></div><div class="form-actions"><button class="btn primary" type="submit">Finalizar Serviço</button></div>`;}

function quoteMoneyValue(value){
  let text=String(value||'').trim().replace(/[^\d,.-]/g,'');
  if(text.includes(','))text=text.replace(/\./g,'').replace(',','.');
  const number=Number(text);
  return Number.isFinite(number)?Math.round(number*100)/100:NaN;
}

function quoteItemRow(){return `<div class="quote-item-row"><input data-quote-description placeholder="Descrição do item"><input data-quote-value inputmode="decimal" placeholder="Valor (R$)"><button type="button" class="btn danger" data-remove-quote-item>Remover</button></div>`;}

function updateQuoteTotal(){
  const total=$$('.quote-item-row').reduce((sum,row)=>{const value=quoteMoneyValue($('[data-quote-value]',row).value);return sum+(Number.isFinite(value)?value:0);},0);
  $('#quoteTotal').textContent=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(total);
}

function bindQuoteForm(){
  const problem=$('#problemsFound'),toggle=$('#generateQuote'),section=$('#quoteSection'),items=$('#quoteItems');
  const syncAvailability=()=>{
    toggle.disabled=!problem.value.trim();
    if(toggle.disabled){toggle.checked=false;section.classList.add('hidden');items.innerHTML='';updateQuoteTotal();}
  };
  problem.addEventListener('input',syncAvailability);
  toggle.addEventListener('change',()=>{
    section.classList.toggle('hidden',!toggle.checked);
    if(toggle.checked&&!items.children.length)items.insertAdjacentHTML('beforeend',quoteItemRow());
    updateQuoteTotal();
  });
  $('#addQuoteItem').onclick=()=>{items.insertAdjacentHTML('beforeend',quoteItemRow());};
  items.addEventListener('click',event=>{const button=event.target.closest('[data-remove-quote-item]');if(button){button.closest('.quote-item-row').remove();if(!items.children.length)items.insertAdjacentHTML('beforeend',quoteItemRow());updateQuoteTotal();}});
  items.addEventListener('input',updateQuoteTotal);
  syncAvailability();
}

async function startService(e){e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button[type=submit]');try{btn.disabled=true;await api('/api/maintenances/start',{method:'POST',body:new FormData(form)});await refreshActiveService();toast('Serviço iniciado.');renderService();}catch(err){toast(err.message,true);}finally{btn.disabled=false;}}
async function completeService(e,id){
  e.preventDefault();
  const form=e.currentTarget,fd=new FormData(form),btn=form.querySelector('button[type=submit]');
  const generateQuote=$('#generateQuote',form)?.checked===true;
  fd.set('services',JSON.stringify($$('input[name=services]:checked',form).map(i=>i.value)));
  fd.set('generate_quote',String(generateQuote));
  if(generateQuote){
    const quoteItems=$$('.quote-item-row',form).map(row=>({description:$('[data-quote-description]',row).value.trim(),value:quoteMoneyValue($('[data-quote-value]',row).value)}));
    if(!quoteItems.length||quoteItems.some(item=>!item.description||!Number.isFinite(item.value)||item.value<=0)){toast('Informe a descrição e um valor maior que zero para cada item do orçamento.',true);return;}
    fd.set('quote_items',JSON.stringify(quoteItems));
  }
  const quoteWindow=generateQuote?window.open('about:blank','_blank'):null;
  if(quoteWindow){quoteWindow.document.write('<p style="font-family:Arial;padding:24px">Gerando orçamento...</p>');quoteWindow.document.close();}
  try{
    btn.disabled=true;btn.textContent=generateQuote?'Finalizando e gerando orçamento...':'Finalizando serviço...';
    const result=await api(`/api/maintenances/${id}/complete`,{method:'POST',body:fd});
    if(result.quote_url){if(quoteWindow)quoteWindow.location.href=result.quote_url;else window.open(result.quote_url,'_blank');}
    else if(quoteWindow)quoteWindow.close();
    await refreshActiveService();toast(generateQuote?'Serviço finalizado e orçamento gerado.':'Serviço finalizado com sucesso.');go('/dashboard');
  }catch(err){if(quoteWindow)quoteWindow.close();toast(err.message,true);}
  finally{btn.disabled=false;btn.textContent='Finalizar Serviço';}
}

async function renderPools(){ state.pools=await api(`/api/pools${state.locationId?`?location_id=${state.locationId}`:''}`);$('#mainContent').innerHTML=`<div class="page"><button class="btn outline back-button" data-go="/dashboard">← Voltar</button><div class="page-head"><div><h1>Gerenciar Piscinas</h1><p>Cadastre e gerencie as piscinas do condomínio</p></div>${canManageLocalData()?'<button id="newPool" class="btn primary">＋ Nova Piscina</button>':''}</div><div class="cards-list">${state.pools.map(poolCard).join('')||'<div class="panel empty">Nenhuma piscina cadastrada.</div>'}</div></div>`;bindRoutes();if($('#newPool'))$('#newPool').onclick=()=>poolModal();$$('[data-edit-pool]').forEach(b=>b.onclick=()=>poolModal(state.pools.find(p=>p.id===b.dataset.editPool)));$$('[data-disable-pool]').forEach(b=>b.onclick=()=>disablePool(b.dataset.disablePool));}
function poolCard(p){return `<article class="item-card"><div class="item-main"><h3>${esc(p.name)} - ${esc(p.location_name)}</h3><div class="item-meta"><span class="badge ${p.is_active?'':'off'}">${p.is_active?'Ativa':'Inativa'}</span><span>${esc(p.pool_location||'Local não informado')}</span><span>${liters(p.volume_liters)}</span></div></div>${canManageLocalData()?`<div class="actions"><button class="btn outline" data-edit-pool="${p.id}">Editar</button><button class="btn danger" data-disable-pool="${p.id}">Desativar</button></div>`:''}</article>`;}
function poolModal(p=null){openModal(p?'Editar Piscina':'Nova Piscina',`<form id="poolForm"><div class="form-grid"><div class="field full-row"><span>Local *</span><select name="location_id" required>${state.locations.map(l=>`<option value="${l.id}" ${l.id===(p?.location_id||state.locationId)?'selected':''}>${esc(l.name)}</option>`).join('')}</select></div><div class="field full-row"><span>Nome da Piscina *</span><input name="name" value="${esc(p?.name||'')}" placeholder="Ex: Piscina Principal" required></div><div class="field"><span>Localização</span><input name="pool_location" value="${esc(p?.pool_location||'')}" placeholder="Ex: Área de Lazer 1"></div><div class="field"><span>Volume (litros)</span><input name="volume_liters" type="number" min="0" value="${esc(p?.volume_liters||'')}"></div><div class="field"><span>Status</span><select name="is_active"><option value="true" ${p?.is_active!==false?'selected':''}>Ativa</option><option value="false" ${p?.is_active===false?'selected':''}>Inativa</option></select></div></div><div class="form-actions"><button type="button" class="btn outline" data-close-modal>Cancelar</button><button class="btn primary" type="submit">${p?'Salvar':'Criar'}</button></div></form>`);$('#poolForm').onsubmit=async e=>{e.preventDefault();const values=Object.fromEntries(new FormData(e.currentTarget));values.is_active=values.is_active==='true';values.volume_liters=values.volume_liters?Number(values.volume_liters):null;try{await api(p?`/api/pools/${p.id}`:'/api/pools',{method:p?'PUT':'POST',body:JSON.stringify(values)});closeModal();toast(`Piscina ${p?'atualizada':'criada'}.`);renderPools();}catch(err){toast(err.message,true);}};}
async function disablePool(id){if(!confirm('Deseja desativar esta piscina? O histórico será preservado.'))return;try{await api(`/api/pools/${id}`,{method:'DELETE'});toast('Piscina desativada.');renderPools();}catch(e){toast(e.message,true);}}

const money=value=>value===null||value===undefined||value===''?'-':new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(value));
const paymentMethodLabel=value=>({PIX:'PIX',BOLETO:'Boleto',TRANSFERENCIA:'Transferência bancária',CARTAO:'Cartão',DINHEIRO:'Dinheiro',DEBITO_AUTOMATICO:'Débito automático',OUTRO:'Outro'}[value]||value||'-');

async function renderPaymentPlans(){
  state.paymentPlans=await api('/api/payment-plans');
  $('#mainContent').innerHTML=`<div class="page"><button class="btn outline back-button" data-go="/dashboard">← Voltar</button><div class="page-head"><div><h1>Planos de pagamento</h1><p>Cadastre os tipos de plano e o que cada um contempla</p></div><button id="newPaymentPlan" class="btn primary">＋ Novo plano</button></div><div class="info payment-plan-info">${isGeneralAdmin()?'O administrador geral visualiza os planos de todos os administradores locais.':'Estes planos pertencem somente ao seu usuário e podem ser associados a qualquer Local vinculado a você.'} Os valores e as condições do contrato são informados separadamente em cada Local.</div><div class="cards-list payment-plan-list">${state.paymentPlans.map(paymentPlanCard).join('')||'<div class="panel empty">Nenhum plano de pagamento cadastrado.</div>'}</div></div>`;
  bindRoutes();
  $('#newPaymentPlan').onclick=()=>paymentPlanModal();
  $$('[data-edit-payment-plan]').forEach(button=>button.onclick=()=>paymentPlanModal(state.paymentPlans.find(plan=>plan.id===button.dataset.editPaymentPlan)));
  $$('[data-disable-payment-plan]').forEach(button=>button.onclick=()=>disablePaymentPlan(button.dataset.disablePaymentPlan));
}

function paymentPlanCard(plan){
  const canEdit=isGeneralAdmin()||String(plan.created_by)===String(state.user.id);
  return `<article class="item-card payment-plan-card"><div class="item-main"><div class="itinerary-title-line"><h3>${esc(plan.name)}</h3><span class="badge ${plan.is_active?'':'off'}">${plan.is_active?'Ativo':'Inativo'}</span></div><div class="item-meta"><strong>Tipo:</strong> ${esc(plan.plan_type)} <span>·</span> <strong>Locais associados:</strong> ${plan.locations_count||0}${isGeneralAdmin()?` <span>· Criado por ${esc(plan.created_by_name)}</span>`:''}</div><div class="plan-included"><strong>O que contempla</strong><p>${esc(plan.included_services)}</p></div></div>${canEdit?`<div class="actions"><button class="btn outline" data-edit-payment-plan="${plan.id}">Editar</button><button class="btn danger" data-disable-payment-plan="${plan.id}">Desativar</button></div>`:''}</article>`;
}

function paymentPlanModal(plan=null){
  openModal(plan?'Editar plano de pagamento':'Novo plano de pagamento',`<form id="paymentPlanForm"><div class="form-grid"><div class="field full-row"><span>Nome do plano *</span><input name="name" value="${esc(plan?.name||'')}" placeholder="Ex: Plano Completo" required></div><div class="field full-row"><span>Tipo do plano *</span><input name="plan_type" value="${esc(plan?.plan_type||'')}" placeholder="Ex: Manutenção completa, Essencial ou Personalizado" required></div><div class="field full-row"><span>O que o plano contempla *</span><textarea name="included_services" placeholder="Descreva os serviços, visitas e atividades incluídas no plano" required>${esc(plan?.included_services||'')}</textarea></div><div class="field"><span>Status</span><select name="is_active"><option value="true" ${plan?.is_active!==false?'selected':''}>Ativo</option><option value="false" ${plan?.is_active===false?'selected':''}>Inativo</option></select></div></div><div class="form-actions"><button type="button" class="btn outline" data-close-modal>Cancelar</button><button class="btn primary" type="submit">Salvar</button></div></form>`);
  $('#paymentPlanForm').onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));values.is_active=values.is_active==='true';try{await api(plan?`/api/payment-plans/${plan.id}`:'/api/payment-plans',{method:plan?'PUT':'POST',body:JSON.stringify(values)});closeModal();toast(`Plano ${plan?'atualizado':'criado'}.`);renderPaymentPlans();}catch(error){toast(error.message,true);}};
}

async function disablePaymentPlan(id){if(!confirm('Deseja desativar este plano? Os locais já associados continuarão com o histórico e os dados do contrato.'))return;try{await api(`/api/payment-plans/${id}`,{method:'DELETE'});toast('Plano desativado.');renderPaymentPlans();}catch(error){toast(error.message,true);}}

async function renderLocations(){state.locations=await api('/api/locations');$('#mainContent').innerHTML=`<div class="page"><button class="btn outline back-button" data-go="/dashboard">← Voltar</button><div class="page-head"><div><h1>Gerenciar Locais</h1><p>Cadastre os prédios e condomínios</p></div>${canManageLocalData()?'<button id="newLocation" class="btn primary">＋ Novo Local</button>':''}</div><div class="cards-list">${state.locations.map(locationCard).join('')||'<div class="panel empty">Nenhum local cadastrado.</div>'}</div></div>`;bindRoutes();if($('#newLocation'))$('#newLocation').onclick=()=>locationModal();$$('[data-edit-location]').forEach(b=>b.onclick=()=>locationModal(state.locations.find(l=>l.id===b.dataset.editLocation)));$$('[data-disable-location]').forEach(b=>b.onclick=()=>disableLocation(b.dataset.disableLocation));}
function locationCard(l){const contacts=Array.isArray(l.notification_contacts)?l.notification_contacts:[];const payment=l.payment_plan_id?`<div class="location-contract"><strong>${esc(l.payment_plan_name||'Plano de pagamento')}</strong><span>${esc(l.payment_plan_type||'')}</span><div><span><b>Contrato:</b> ${money(l.contract_value)}</span><span><b>Forma:</b> ${esc(paymentMethodLabel(l.payment_method))}</span><span><b>${l.payment_type==='INSTALLMENTS'?'Parcelamento':'Mensalidade'}:</b> ${l.payment_type==='INSTALLMENTS'?`${l.installment_count}x de ${money(l.installment_amount)}`:money(l.monthly_amount)}</span></div></div>`:'<div class="location-contract empty-contract">Plano de pagamento não associado</div>';return `<article class="item-card location-card"><div class="item-main"><h3>${esc(l.name)}</h3><div class="item-meta"><span class="badge ${l.is_active?'':'off'}">${l.is_active?'Ativo':'Inativo'}</span><span>${esc(l.address||'Endereço não informado')}</span></div><div class="item-meta" style="margin-top:8px"><strong>CNPJ/CPF:</strong> ${esc(l.document_number||'Não informado')}</div>${payment}<div class="item-meta" style="margin-top:8px"><strong>Emails para relatórios:</strong> ${(l.report_emails||[]).map(esc).join(' • ')||'Nenhum'}</div><div class="item-meta" style="margin-top:8px"><strong>Contatos para alertas e relatórios:</strong> ${contacts.map(c=>`${esc(c.name)}: ${esc(c.phone)}`).join(' • ')||'Nenhum'}</div></div>${canManageLocalData()?`<div class="actions"><button class="btn outline" data-edit-location="${l.id}">Editar</button><button class="btn danger" data-disable-location="${l.id}">Desativar</button></div>`:''}</article>`;}
function locationContactRow(contact={}){return `<div class="location-contact-row"><input data-contact-name value="${esc(contact.name||'')}" placeholder="Nome do contato"><input data-contact-phone type="tel" value="${esc(contact.phone||'')}" placeholder="Telefone com DDD"><button type="button" class="btn danger" data-remove-contact>Remover</button></div>`;}
function bindLocationContactRows(){const list=$('#locationContacts');if(!list)return;list.onclick=e=>{const button=e.target.closest('[data-remove-contact]');if(button)button.closest('.location-contact-row').remove();};$('#addLocationContact').onclick=()=>list.insertAdjacentHTML('beforeend',locationContactRow());}
function syncLocationPaymentFields(){const plan=$('#locationPaymentPlan'),section=$('#locationContractFields'),type=$('#locationPaymentType'),monthly=$('#locationMonthlyFields'),installments=$('#locationInstallmentFields'),info=$('#selectedPlanInfo');if(!plan||!section)return;const hasPlan=Boolean(plan.value);section.classList.toggle('hidden',!hasPlan);monthly.classList.toggle('hidden',type.value!=='MONTHLY');installments.classList.toggle('hidden',type.value!=='INSTALLMENTS');const selected=state.paymentPlans.find(item=>item.id===plan.value);info.textContent=selected?`${selected.plan_type}: ${selected.included_services}`:'';}
async function locationModal(l=null){
  const contacts=Array.isArray(l?.notification_contacts)?l.notification_contacts:[];
  try{state.paymentPlans=await api('/api/payment-plans');}catch(error){toast(error.message,true);return;}
  const planOptions=state.paymentPlans.map(plan=>`<option value="${plan.id}" ${plan.id===l?.payment_plan_id?'selected':''} ${!plan.is_active&&plan.id!==l?.payment_plan_id?'disabled':''}>${esc(plan.name)} · ${esc(plan.plan_type)}${plan.is_active?'':' (Inativo)'}</option>`).join('');
  openModal(l?'Editar Local':'Novo Local',`<form id="locationForm"><div class="form-grid"><div class="field full-row"><span>Nome do Local *</span><input name="name" value="${esc(l?.name||'')}" placeholder="Ex: Vivere Palhano" required></div><div class="field full-row"><span>Endereço</span><input name="address" value="${esc(l?.address||'')}" placeholder="Ex: Rua ABC, 123"></div><div class="field full-row"><span>CNPJ/CPF</span><input name="document_number" value="${esc(l?.document_number||'')}" placeholder="Informe CPF ou CNPJ"><small>CPF com 11 dígitos ou CNPJ com 14 dígitos.</small></div><div class="field full-row contract-divider"><span>Plano de pagamento</span><select name="payment_plan_id" id="locationPaymentPlan"><option value="">Sem plano associado</option>${planOptions}</select><small id="selectedPlanInfo" class="selected-plan-info"></small></div><div id="locationContractFields" class="form-grid full-row contract-fields"><div class="field"><span>Valor total do contrato *</span><input name="contract_value" type="number" min="0.01" step="0.01" value="${esc(l?.contract_value||'')}" placeholder="0,00"></div><div class="field"><span>Forma de pagamento *</span><select name="payment_method"><option value="">Selecione</option>${[['PIX','PIX'],['BOLETO','Boleto'],['TRANSFERENCIA','Transferência bancária'],['CARTAO','Cartão'],['DINHEIRO','Dinheiro'],['DEBITO_AUTOMATICO','Débito automático'],['OUTRO','Outro']].map(([value,label])=>`<option value="${value}" ${l?.payment_method===value?'selected':''}>${label}</option>`).join('')}</select></div><div class="field"><span>Tipo de pagamento *</span><select name="payment_type" id="locationPaymentType"><option value="MONTHLY" ${l?.payment_type!=='INSTALLMENTS'?'selected':''}>Mensal</option><option value="INSTALLMENTS" ${l?.payment_type==='INSTALLMENTS'?'selected':''}>Parcelado</option></select></div><div id="locationMonthlyFields" class="field"><span>Valor mensal *</span><input name="monthly_amount" type="number" min="0.01" step="0.01" value="${esc(l?.monthly_amount||'')}" placeholder="0,00"></div><div id="locationInstallmentFields" class="form-grid full-row"><div class="field"><span>Quantidade de parcelas *</span><input name="installment_count" type="number" min="1" step="1" value="${esc(l?.installment_count||'')}"></div><div class="field"><span>Valor de cada parcela *</span><input name="installment_amount" type="number" min="0.01" step="0.01" value="${esc(l?.installment_amount||'')}" placeholder="0,00"></div></div></div><div class="field full-row"><span>Emails para Relatórios</span><textarea name="report_emails" placeholder="Um e-mail por linha">${esc((l?.report_emails||[]).join('\n'))}</textarea></div><div class="field full-row"><span>Contatos para Alertas e Relatórios</span><div id="locationContacts" class="location-contacts">${contacts.map(locationContactRow).join('')}</div><button id="addLocationContact" type="button" class="btn secondary location-contact-add">＋ Adicionar contato</button><small>Cadastre o nome e o telefone com DDD. O envio automático será adicionado futuramente.</small></div><div class="field"><span>Status</span><select name="is_active"><option value="true" ${l?.is_active!==false?'selected':''}>Ativo</option><option value="false" ${l?.is_active===false?'selected':''}>Inativo</option></select></div></div><div class="form-actions"><button type="button" class="btn outline" data-close-modal>Cancelar</button><button class="btn primary" type="submit">${l?'Salvar':'Criar'}</button></div></form>`);
  bindLocationContactRows();
  $('#locationPaymentPlan').onchange=syncLocationPaymentFields;$('#locationPaymentType').onchange=syncLocationPaymentFields;syncLocationPaymentFields();
  $('#locationForm').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,v=Object.fromEntries(new FormData(form));const documentDigits=String(v.document_number||'').replace(/\D/g,'');if(documentDigits&&![11,14].includes(documentDigits.length)){toast('Informe um CPF com 11 dígitos ou CNPJ com 14 dígitos.',true);return;}v.is_active=v.is_active==='true';v.notification_contacts=$$('.location-contact-row',form).map(row=>({name:$('[data-contact-name]',row).value.trim(),phone:$('[data-contact-phone]',row).value.trim()})).filter(c=>c.name||c.phone);if(v.notification_contacts.some(c=>!c.name||!c.phone)){toast('Informe o nome e o telefone de cada contato.',true);return;}try{await api(l?`/api/locations/${l.id}`:'/api/locations',{method:l?'PUT':'POST',body:JSON.stringify(v)});closeModal();toast(`Local ${l?'atualizado':'criado'}.`);await loadBase();renderLocations();}catch(err){toast(err.message,true);}};
}
async function disableLocation(id){if(!confirm('Deseja desativar este local? Os dados e o histórico serão preservados.'))return;try{await api(`/api/locations/${id}`,{method:'DELETE'});toast('Local desativado.');await loadBase();renderLocations();}catch(e){toast(e.message,true);}}

function dateOnlyBr(value){return value?String(value).slice(0,10).split('-').reverse().join('/'):'-';}
function itineraryStatus(item){if(!item.total_stops)return 'Sem paradas';if(item.visited_stops===item.total_stops)return 'Concluído';if(item.visited_stops>0)return 'Em andamento';return 'Planejado';}
function itineraryCard(item){const status=itineraryStatus(item);return `<article class="item-card itinerary-card"><div class="item-main"><div class="itinerary-title-line"><h3>${esc(item.title)}</h3><span class="badge ${status==='Concluído'?'':status==='Em andamento'?'progress':'off'}">${status}</span></div><div class="item-meta"><span>📅 ${dateOnlyBr(item.service_date)}</span><span>👤 Responsável: ${esc(item.responsible_name)}</span><span>📍 ${item.visited_stops}/${item.total_stops} visitados</span><span>✓ ${item.serviced_stops} com serviço</span>${item.no_service_stops?`<span>⚠ ${item.no_service_stops} sem serviço</span>`:''}</div></div><div class="actions"><button class="btn primary" data-open-itinerary="${item.id}">Abrir</button>${item.can_edit&&Number(item.visited_stops)===0?`<button class="btn outline" data-edit-itinerary="${item.id}">Editar</button><button class="btn danger" data-delete-itinerary="${item.id}">Excluir</button>`:''}</div></article>`;}

async function renderItineraries(){
  const queryDate=new URLSearchParams(location.search).get('service_date')||brazilInputDate();
  const itineraries=await api(`/api/itineraries?service_date=${encodeURIComponent(queryDate)}`);
  $('#mainContent').innerHTML=`<div class="page"><div class="page-head"><div><h1>Itinerários</h1><p>Organize a sequência de visitas aos locais</p></div><div class="page-head-actions"><button id="itineraryReport" class="btn outline">▤ Relatório</button><button id="newItinerary" class="btn primary">＋ Novo itinerário</button></div></div><div class="panel itinerary-filter"><div class="field"><span>Data das visitas</span><input id="itineraryDate" type="date" value="${esc(queryDate)}"></div><button id="filterItinerary" class="btn outline">Filtrar</button></div><div class="cards-list itinerary-list">${itineraries.map(itineraryCard).join('')||'<div class="panel empty">Nenhum itinerário encontrado nesta data.</div>'}</div></div>`;
  $('#newItinerary').onclick=()=>itineraryFormModal();
  $('#itineraryReport').onclick=()=>itineraryReportModal();
  $('#filterItinerary').onclick=()=>go(`/itineraries?service_date=${encodeURIComponent($('#itineraryDate').value)}`);
  $$('[data-open-itinerary]').forEach(button=>button.onclick=()=>openItinerary(button.dataset.openItinerary));
  $$('[data-edit-itinerary]').forEach(button=>button.onclick=async()=>itineraryFormModal(await api(`/api/itineraries/${button.dataset.editItinerary}`)));
  $$('[data-delete-itinerary]').forEach(button=>button.onclick=()=>deleteItinerary(button.dataset.deleteItinerary));
}

function itineraryLocationRows(existing,responsible){
  const positions=new Map((existing?.stops||[]).map(stop=>[stop.location_id,stop.position]));
  const allowed=responsible?.role==='ADMIN'?null:new Set(responsible?.location_ids||[]);
  const locations=state.locations.filter(item=>item.is_active&&(!allowed||allowed.has(item.id)));
  return locations.map((item,index)=>`<label class="itinerary-location"><input type="checkbox" data-itinerary-location value="${item.id}" ${positions.has(item.id)?'checked':''}><span><strong>${esc(item.name)}</strong><small>${esc(item.address||'Endereço não informado')}</small></span><input type="number" min="1" data-itinerary-position value="${positions.get(item.id)||index+1}" aria-label="Ordem da visita"></label>`).join('')||'<div class="empty">Este usuário não possui locais disponíveis em comum.</div>';
}

async function itineraryFormModal(existing=null){
  let assignees;
  try{assignees=await api('/api/itinerary-users');}catch(error){toast(error.message,true);return;}
  const selectedId=existing?.responsible_user_id||state.user.id;
  const selected=assignees.find(user=>user.id===selectedId)||assignees[0];
  if(!selected){toast('Nenhum usuário disponível para receber o itinerário.',true);return;}
  const responsibleField=canManageLocalData()?`<div class="field"><span>Usuário responsável *</span><select name="responsible_user_id" id="itineraryResponsible" required>${assignees.map(user=>`<option value="${user.id}" ${user.id===selected.id?'selected':''}>${esc(user.name)} · ${esc(roleLabel(user.role))}</option>`).join('')}</select><small>Os locais serão limitados aos associados ao usuário escolhido.</small></div>`:`<input type="hidden" name="responsible_user_id" value="${selected.id}">`;
  openModal(existing?'Editar itinerário':'Novo itinerário',`<form id="itineraryForm"><div class="form-grid"><div class="field full-row"><span>Nome do itinerário *</span><input name="title" value="${esc(existing?.title||'Rota de visitas')}" required></div><div class="field"><span>Data *</span><input name="service_date" type="date" value="${esc(existing?.service_date?String(existing.service_date).slice(0,10):brazilInputDate())}" required></div>${responsibleField}<div class="field full-row"><span>Locais e ordem das visitas *</span><div id="itineraryLocations" class="itinerary-locations">${itineraryLocationRows(existing,selected)}</div><small>Marque os locais e informe a ordem em que devem ser visitados.</small></div></div><div class="form-actions"><button type="button" class="btn outline" data-close-modal>Cancelar</button><button class="btn primary" type="submit">Salvar itinerário</button></div></form>`);
  if($('#itineraryResponsible'))$('#itineraryResponsible').onchange=event=>{const responsible=assignees.find(user=>user.id===event.target.value);$('#itineraryLocations').innerHTML=itineraryLocationRows(existing,responsible);};
  $('#itineraryForm').onsubmit=async event=>{
    event.preventDefault();
    const form=event.currentTarget,values=Object.fromEntries(new FormData(form));
    const selected=$$('[data-itinerary-location]:checked',form).map((checkbox,index)=>{const row=checkbox.closest('.itinerary-location');return{id:checkbox.value,position:Number($('[data-itinerary-position]',row).value)||index+1,address:state.locations.find(item=>item.id===checkbox.value)?.address};}).sort((a,b)=>a.position-b.position);
    if(!selected.length){toast('Selecione pelo menos um local.',true);return;}
    const missingAddress=selected.find(item=>!String(item.address||'').trim());
    if(missingAddress){toast('Todos os locais do itinerário precisam ter endereço cadastrado.',true);return;}
    try{await api(existing?`/api/itineraries/${existing.id}`:'/api/itineraries',{method:existing?'PUT':'POST',body:JSON.stringify({title:values.title,service_date:values.service_date,responsible_user_id:values.responsible_user_id,location_ids:selected.map(item=>item.id)})});closeModal();toast(`Itinerário ${existing?'atualizado':'criado'}.`);go(`/itineraries?service_date=${encodeURIComponent(values.service_date)}`);}catch(error){toast(error.message,true);}
  };
}

function googleMapsRoute(stops){
  const addresses=stops.map(stop=>String(stop.address||'').trim()).filter(Boolean);
  if(!addresses.length)return '';
  const destination=addresses[addresses.length-1];
  const params=new URLSearchParams({api:'1',destination,travelmode:'driving'});
  if(addresses.length>1)params.set('waypoints',addresses.slice(0,-1).join('|'));
  return `https://www.google.com/maps/dir/?${params}`;
}

function itineraryStopCard(stop){
  const done=stop.status!=='PENDING';
  const status=stop.status==='VISITED_SERVICE'?'✓ Serviço realizado':stop.status==='VISITED_NO_SERVICE'?'✓ Visitado sem serviço':'Pendente';
  return `<article class="itinerary-stop ${done?'done':''}"><div class="stop-position">${stop.position}</div><div class="stop-content"><div class="itinerary-title-line"><h3>${esc(stop.location_name)}</h3><span class="badge ${stop.status==='VISITED_NO_SERVICE'?'warning':done?'':'off'}">${status}</span></div><p>${esc(stop.address||'Endereço não informado')}</p>${stop.pool_name?`<p><strong>Piscina:</strong> ${esc(stop.pool_name)} · ${brDate(stop.ended_at)}</p>`:''}${stop.visit_notes?`<div class="stop-notes"><strong>Motivo:</strong> ${esc(stop.visit_notes)}</div>`:''}</div>${stop.status==='PENDING'?`<div class="stop-actions"><button class="btn primary" data-start-stop="${stop.id}" data-location-id="${stop.location_id}">Iniciar serviço</button><button class="btn outline" data-no-service="${stop.id}">Visitado sem serviço</button></div>`:stop.maintenance_id?`<button class="btn outline" data-maintenance-id="${stop.maintenance_id}">Ver serviço</button>`:''}</article>`;
}

async function openItinerary(id){
  try{
    const item=await api(`/api/itineraries/${id}`),mapsUrl=googleMapsRoute(item.stops);
    openModal(item.title,`<div class="itinerary-detail-head"><div><strong>${dateOnlyBr(item.service_date)}</strong><small>Responsável: ${esc(item.responsible_name)}</small>${item.created_by_name!==item.responsible_name?`<small>Criado por ${esc(item.created_by_name)}</small>`:''}</div>${mapsUrl?`<a class="btn primary" href="${esc(mapsUrl)}" target="_blank" rel="noopener">Abrir rota no Google Maps</a>`:''}</div><div class="itinerary-stops">${item.stops.map(itineraryStopCard).join('')}</div>`);
    $$('[data-start-stop]').forEach(button=>button.onclick=async()=>{const locationId=button.dataset.locationId;state.locationId=locationId;localStorage.setItem('aquaguard_location',locationId);state.pools=await api(`/api/pools?location_id=${encodeURIComponent(locationId)}`);closeModal();go(`/startservice?itinerary_stop_id=${encodeURIComponent(button.dataset.startStop)}&location_id=${encodeURIComponent(locationId)}`);});
    $$('[data-no-service]').forEach(button=>button.onclick=()=>noServiceModal(id,button.dataset.noService));
    $$('[data-maintenance-id]').forEach(button=>button.onclick=()=>openMaintenance(button.dataset.maintenanceId));
  }catch(error){toast(error.message,true);}
}

function noServiceModal(itineraryId,stopId){
  openModal('Visita sem serviço',`<form id="noServiceForm"><div class="field"><span>Por que o serviço não foi realizado? *</span><textarea name="notes" placeholder="Ex: acesso ao local não autorizado, piscina interditada ou responsável ausente" required></textarea></div><div class="form-actions"><button type="button" class="btn outline" data-close-modal>Cancelar</button><button class="btn primary" type="submit">Registrar visita</button></div></form>`);
  $('#noServiceForm').onsubmit=async event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));try{await api(`/api/itineraries/${itineraryId}/stops/${stopId}/no-service`,{method:'POST',body:JSON.stringify(values)});closeModal();toast('Visita registrada sem serviço.');if(currentRoute()==='dashboard')await renderDashboard();else await renderItineraries();openItinerary(itineraryId);}catch(error){toast(error.message,true);}};
}

async function deleteItinerary(id){if(!confirm('Deseja excluir este itinerário?'))return;try{await api(`/api/itineraries/${id}`,{method:'DELETE'});toast('Itinerário excluído.');renderItineraries();}catch(error){toast(error.message,true);}}

function itineraryReportModal(){
  const today=brazilInputDate(),monthStart=`${today.slice(0,8)}01`;
  openModal('Relatório de itinerários',`<form id="itineraryReportForm"><div class="form-grid"><div class="field"><span>Data inicial *</span><input name="date_from" type="date" value="${monthStart}" required></div><div class="field"><span>Data final *</span><input name="date_to" type="date" value="${today}" required></div></div><div class="form-actions"><button type="button" class="btn outline" data-close-modal>Cancelar</button><button class="btn primary" type="submit">Gerar relatório</button></div></form>`);
  $('#itineraryReportForm').onsubmit=event=>{event.preventDefault();const values=Object.fromEntries(new FormData(event.currentTarget));if(values.date_from>values.date_to){toast('A data inicial não pode ser maior que a data final.',true);return;}closeModal();go(`/itineraries?view=report&date_from=${encodeURIComponent(values.date_from)}&date_to=${encodeURIComponent(values.date_to)}`);};
}

function itineraryReportStatus(row){if(row.status==='VISITED_SERVICE')return '<span class="badge">Realizado</span>';if(row.status==='VISITED_NO_SERVICE')return '<span class="badge warning">Sem serviço</span>';return '<span class="badge off">Não visitado</span>';}

function itineraryReportRows(rows){
  if(!rows.length)return '<div class="empty">Nenhum itinerário encontrado no período informado.</div>';
  return `<div class="report-table-wrap"><table class="report-table itinerary-report-table"><thead><tr><th>Data</th><th>Itinerário</th><th>Responsável</th><th>Ordem</th><th>Local</th><th>Visita</th><th>Serviço feito</th><th>Piscina</th><th>Data da visita</th><th>Observação</th><th class="no-print"></th></tr></thead><tbody>${rows.map(row=>`<tr><td>${dateOnlyBr(row.service_date)}</td><td>${esc(row.title)}</td><td>${esc(row.responsible_name)}</td><td>${row.position}</td><td>${esc(row.location_name)}</td><td>${itineraryReportStatus(row)}</td><td><strong class="${row.status==='VISITED_SERVICE'?'report-yes':'report-no'}">${row.status==='VISITED_SERVICE'?'Sim':'Não'}</strong></td><td>${esc(row.pool_name||'-')}</td><td>${row.visited_at?brDate(row.visited_at):'-'}</td><td class="report-observation">${esc(row.visit_notes||'-')}</td><td class="no-print">${row.maintenance_id?`<button class="btn outline itinerary-report-detail" data-id="${row.maintenance_id}">Detalhes</button>`:''}</td></tr>`).join('')}</tbody></table></div>`;
}

async function renderItineraryReport(){
  const query=new URLSearchParams(location.search),today=brazilInputDate();
  const dateFrom=query.get('date_from')||`${today.slice(0,8)}01`,dateTo=query.get('date_to')||today;
  const report=await api(`/api/reports/itineraries?date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}`);
  $('#mainContent').innerHTML=`<div class="page itinerary-report-page"><div class="page-head"><div><button class="btn outline back-button no-print" data-go="/itineraries">← Voltar aos itinerários</button><h1>Relatório de itinerários</h1><p>Período: ${dateOnlyBr(dateFrom)} a ${dateOnlyBr(dateTo)}</p></div><div class="page-head-actions no-print"><button id="changeItineraryReport" class="btn outline">Alterar período</button><button id="printItineraryReport" class="btn primary">🖨 Imprimir</button></div></div><section class="stats itinerary-report-stats"><div class="stat-card"><span>Visitas previstas</span><strong>${report.summary.total}</strong></div><div class="stat-card"><span>Serviços realizados</span><strong>${report.summary.services}</strong></div><div class="stat-card"><span>Visitados sem serviço</span><strong>${report.summary.no_service}</strong></div><div class="stat-card"><span>Não visitados</span><strong>${report.summary.pending}</strong></div></section><section class="panel report-results">${itineraryReportRows(report.rows)}</section></div>`;
  bindRoutes();
  $('#changeItineraryReport').onclick=()=>itineraryReportModal();
  $('#printItineraryReport').onclick=()=>window.print();
  $$('.itinerary-report-detail').forEach(button=>button.onclick=()=>openMaintenance(button.dataset.id));
}

function brazilInputDate(value=new Date()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value);
  const get=type=>parts.find(p=>p.type===type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function reportPoolOptions(pools,selected=''){
  return `<option value="">Todas as piscinas</option>${pools.filter(p=>p.is_active).map(p=>`<option value="${p.id}" ${p.id===selected?'selected':''}>${esc(p.name)}${p.location_name?` · ${esc(p.location_name)}`:''}</option>`).join('')}`;
}

function reportRows(rows){
  if(!rows.length)return '<div class="empty">Nenhuma manutenção encontrada para os filtros informados.</div>';
  return `<div class="report-table-wrap"><table class="report-table"><thead><tr><th>Data</th><th>Local</th><th>Piscina</th><th>Executante</th><th>pH</th><th>Cloro</th><th>Alcalinidade</th><th>Estabilizador</th><th>Itens executados</th><th class="no-print"></th></tr></thead><tbody>${rows.map(m=>`<tr><td>${brDate(m.started_at)}</td><td>${esc(m.location_name)}</td><td>${esc(m.pool_name)}</td><td>${esc(m.executor)}</td><td>${esc(m.ph??'-')}</td><td>${esc(m.chlorine??'-')} ppm</td><td>${esc(m.alkalinity??'-')} ppm</td><td>${esc(m.stabilizer??'-')} ppm</td><td>${(m.services||[]).length}</td><td class="no-print"><button class="btn outline report-detail" data-id="${m.id}">Detalhes</button></td></tr>`).join('')}</tbody></table></div>`;
}

async function loadReportResults(){
  const form=$('#reportFilters');
  const values=Object.fromEntries(new FormData(form));
  const query=new URLSearchParams();
  if(values.location_id)query.set('location_id',values.location_id);
  if(values.pool_id)query.set('pool_id',values.pool_id);
  if(values.date_from)query.set('date_from',values.date_from);
  if(values.date_to)query.set('date_to',values.date_to);
  const button=form.querySelector('button[type=submit]');
  try{
    button.disabled=true;
    const report=await api(`/api/reports/maintenances?${query}`);
    const locationLabel=$('#reportLocation')?.selectedOptions[0]?.textContent||'Todos os locais';
    const poolLabel=$('#reportPool')?.selectedOptions[0]?.textContent||'Todas as piscinas';
    const formatDate=value=>value?value.split('-').reverse().join('/'):'Sem limite';
    $('#reportContext').innerHTML=`<strong>${esc(locationLabel)}</strong><span>${esc(poolLabel)}</span><span>Período: ${formatDate(values.date_from)} a ${formatDate(values.date_to)}</span>`;
    $('#reportSummary').innerHTML=`<section class="stats report-stats"><div class="stat-card"><span>Manutenções</span><strong>${report.summary.total}</strong></div><div class="stat-card"><span>Piscinas atendidas</span><strong>${report.summary.pools}</strong></div><div class="stat-card"><span>Serviços executados</span><strong>${report.summary.services}</strong></div></section>`;
    $('#reportResults').innerHTML=reportRows(report.rows);
    $('#printReport').disabled=!report.rows.length;
    $$('.report-detail').forEach(b=>b.onclick=()=>openMaintenance(b.dataset.id));
  }catch(error){toast(error.message,true);$('#reportResults').innerHTML=`<div class="empty">${esc(error.message)}</div>`;}
  finally{button.disabled=false;}
}

async function renderReports(){
  const today=brazilInputDate(),monthStart=`${today.slice(0,8)}01`;
  const selectedLocation=state.locationId||'';
  const initialPools=await api(`/api/pools${selectedLocation?`?location_id=${selectedLocation}`:''}`);
  $('#mainContent').innerHTML=`<div class="page report-page"><div class="page-head"><div><h1>Relatórios</h1><p>Consulte as manutenções por local, piscina e período</p></div><button id="printReport" class="btn outline no-print" disabled>🖨 Imprimir</button></div>
    <form id="reportFilters" class="panel report-filters no-print"><div class="field"><span>Local</span><select name="location_id" id="reportLocation">${isGeneralAdmin()?'<option value="">Todos os locais</option>':''}${state.locations.map(l=>`<option value="${l.id}" ${l.id===selectedLocation?'selected':''}>${esc(l.name)}</option>`).join('')}</select></div><div class="field"><span>Piscina</span><select name="pool_id" id="reportPool">${reportPoolOptions(initialPools)}</select></div><div class="field"><span>Data inicial</span><input name="date_from" type="date" value="${monthStart}" required></div><div class="field"><span>Data final</span><input name="date_to" type="date" value="${today}" required></div><button class="btn primary" type="submit">Filtrar relatório</button></form>
    <div id="reportContext" class="report-context"></div><div id="reportSummary"></div><section id="reportResults" class="panel report-results"><div class="empty">Carregando relatório...</div></section></div>`;
  $('#reportFilters').onsubmit=e=>{e.preventDefault();loadReportResults();};
  $('#printReport').onclick=()=>window.print();
  $('#reportLocation').onchange=async e=>{$('#reportPool').innerHTML=reportPoolOptions(await api(`/api/pools${e.target.value?`?location_id=${e.target.value}`:''}`));};
  await loadReportResults();
}

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
