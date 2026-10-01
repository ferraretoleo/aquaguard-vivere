let users=[];
let locations=[];
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=value=>String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

const subscriptionPlans={PISCINA:{name:'Piscina',limit:'1 piscina',price:29.90},CONDOMINIO:{name:'Condomínio',limit:'Até 3 piscinas',price:49.90},PROFISSIONAL:{name:'Profissional',limit:'Até 10 piscinas',price:109.90},EMPRESA:{name:'Empresa',limit:'Acima de 10 piscinas',price:209.90}};
const money=value=>Number(value).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const localDate=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const roleLabels={ADMIN:'Administrador geral',LOCAL_ADMIN:'Administrador local',USER:'Usuário'};

async function api(url,options={}){
  const response=await fetch(url,{credentials:'same-origin',...options,headers:{'content-type':'application/json',...(options.headers||{})}});
  if(response.status===401){location.href='/login?from=/usuarios';throw new Error('Entre novamente.');}
  if(response.status===403){location.href='/dashboard';throw new Error('Acesso exclusivo para administrador geral.');}
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Não foi possível concluir.');
  return data;
}

function toast(message,error=false){const el=$('#toast');el.textContent=message;el.className=`toast show${error?' error':''}`;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className='toast',3200);}
function closeModal(){$('#modalRoot').innerHTML='';}
function openModal(title,body){$('#modalRoot').innerHTML=`<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>${esc(title)}</h2><button class="modal-close" data-close aria-label="Fechar">×</button></div><div class="modal-body">${body}</div></section></div>`;$('[data-close]').onclick=closeModal;$('.modal-backdrop').onclick=e=>{if(e.target===e.currentTarget)closeModal();};}

function locationNames(user){
  const names=(user.locations||[]).map(item=>item.name).filter(Boolean);
  return names.length?names.join(' • '):(user.role==='ADMIN'?'Todos os locais':'Nenhum local');
}

function render(){
  const term=$('#userSearch').value.trim().toLowerCase();
  const filtered=users.filter(u=>`${u.name} ${u.email} ${locationNames(u)} ${roleLabels[u.role]||u.role}`.toLowerCase().includes(term));
  $('#userCount').textContent=`${filtered.length} usuário(s)`;
  $('#usersList').innerHTML=filtered.length?filtered.map(u=>`<article class="user-row"><div class="user-info"><strong>${esc(u.name)}</strong><span>${esc(u.email)}</span>${u.role==='LOCAL_ADMIN'&&u.subscription?`<small>${esc(subscriptionPlans[u.subscription.plan]?.name)}: ${money(u.subscription.monthly_amount)}/mês, vence dia ${u.subscription.due_day}</small>`:''}</div><div class="location-name">${esc(locationNames(u))}</div><div class="role-badge">${esc(roleLabels[u.role]||u.role)}</div><span class="badge ${u.is_active?'':'off'}">${u.is_active?'Ativo':'Inativo'}</span><div class="user-actions"><button class="btn outline" data-edit="${u.id}">Editar</button>${u.role==='LOCAL_ADMIN'&&u.subscription?`<button class="btn outline" data-payments="${u.id}">Mensalidades</button>`:''}</div></article>`).join(''):'<div class="empty">Nenhum usuário encontrado.</div>';
  $$('[data-payments]').forEach(button=>button.onclick=()=>paymentsModal(users.find(u=>u.id===button.dataset.payments)).catch(e=>toast(e.message,true)));
  $$('[data-edit]').forEach(button=>button.onclick=()=>userModal(users.find(user=>user.id===button.dataset.edit)));
}

async function loadUsers(){users=await api('/api/users');render();}

function locationChecklist(user){
  const selected=new Set(user?.location_ids||[]);
  return locations.map(item=>`<label class="location-option"><input type="checkbox" name="location_ids" value="${item.id}" ${selected.has(item.id)?'checked':''}><span><strong>${esc(item.name)}</strong>${item.address?`<small>${esc(item.address)}</small>`:''}</span></label>`).join('');
}

function userModal(user=null){
  openModal(user?'Editar Usuário':'Novo Usuário',`<form id="userForm"><div class="form-grid"><div class="field full-row"><span>Nome *</span><input name="name" value="${esc(user?.name||'')}" required></div><div class="field full-row"><span>E-mail *</span><input name="email" type="email" value="${esc(user?.email||'')}" required></div><div class="field full-row"><span>${user?'Nova senha':'Senha *'}</span><input name="password" type="password" minlength="8" ${user?'':'required'} autocomplete="new-password"><div class="password-help">${user?'Deixe em branco para manter a senha atual.':'Use pelo menos 8 caracteres.'}</div></div><div class="field"><span>Nível de acesso</span><select name="role"><option value="USER" ${!user||user.role==='USER'?'selected':''}>Usuário</option><option value="LOCAL_ADMIN" ${user?.role==='LOCAL_ADMIN'?'selected':''}>Administrador local</option><option value="ADMIN" ${user?.role==='ADMIN'?'selected':''}>Administrador geral</option></select></div><div class="field"><span>Status</span><select name="is_active"><option value="true" ${user?.is_active!==false?'selected':''}>Ativo</option><option value="false" ${user?.is_active===false?'selected':''}>Inativo</option></select></div><div id="subscriptionField" class="field full-row"><span>Assinatura do AquaGuard</span><label><input type="checkbox" name="has_subscription" ${user?.subscription?'checked':''}> Controlar mensalidade deste cliente</label><div id="subscriptionInputs" class="form-grid"><div class="field full-row"><span>Plano contratado</span><select name="subscription_plan">${Object.entries(subscriptionPlans).map(([key,plan])=>`<option value="${key}" ${user?.subscription?.plan===key?'selected':''}>${plan.name}, ${plan.limit}, ${money(plan.price)}/mês</option>`).join('')}</select></div><div class="field"><span>Mensalidade contratada (R$)</span><input name="monthly_amount" type="number" min="0" max="9999999999.99" step="0.01" value="${esc(user?.subscription?.monthly_amount??29.90)}"></div><div class="field"><span>Dia do vencimento</span><input name="due_day" type="number" min="1" max="31" step="1" value="${esc(user?.subscription?.due_day??10)}"></div></div><small>Controle exclusivo do administrador geral. Os limites são referências do plano, sem bloqueio automático. Em meses curtos, considere o último dia do mês para vencimentos 29, 30 e 31.</small></div><div id="locationsField" class="field full-row"><span>Locais associados *</span><div class="location-checklist">${locationChecklist(user)}</div><div id="locationHelp" class="password-help"></div></div></div><div class="form-actions"><button type="button" class="btn outline" data-cancel>Cancelar</button><button class="btn primary" type="submit">${user?'Salvar alterações':'Cadastrar usuário'}</button></div></form>`);
  $('[data-cancel]').onclick=closeModal;
  const form=$('#userForm');
  const roleSelect=form.elements.role;
  const updateLocations=()=>{
    const generalAdmin=roleSelect.value==='ADMIN';
    $('#subscriptionField').hidden=roleSelect.value!=='LOCAL_ADMIN';
    updateSubscription();
    $$('#locationsField input[type=checkbox]').forEach(input=>input.disabled=generalAdmin);
    $('#locationsField').classList.toggle('locations-disabled',generalAdmin);
    $('#locationHelp').textContent=generalAdmin?'O administrador geral vê todos os locais.':'Selecione um ou mais locais para este usuário.';
  };
  const updateSubscription=()=>{
    const enabled=roleSelect.value==='LOCAL_ADMIN'&&form.elements.has_subscription.checked;
    $('#subscriptionInputs').hidden=!enabled;
    ['subscription_plan','monthly_amount','due_day'].forEach(name=>{form.elements[name].disabled=!enabled;form.elements[name].required=enabled;});
  };
  form.elements.has_subscription.onchange=updateSubscription;
  form.elements.subscription_plan.onchange=()=>form.elements.monthly_amount.value=subscriptionPlans[form.elements.subscription_plan.value].price.toFixed(2);
  roleSelect.onchange=updateLocations;
  updateLocations();
  form.onsubmit=async event=>{
    event.preventDefault();
    const button=form.querySelector('[type=submit]');
    const role=roleSelect.value;
    const locationIds=role==='ADMIN'?[]:$$('input[name=location_ids]:checked',form).map(input=>input.value);
    if(role!=='ADMIN'&&!locationIds.length){toast('Selecione pelo menos um local.',true);return;}
    const data={name:form.elements.name.value,email:form.elements.email.value,password:form.elements.password.value,role,is_active:form.elements.is_active.value==='true',location_ids:locationIds};
    data.subscription=role==='LOCAL_ADMIN'&&form.elements.has_subscription.checked?{plan:form.elements.subscription_plan.value,monthly_amount:form.elements.monthly_amount.value,due_day:form.elements.due_day.value}:null;
    try{
      button.disabled=true;
      await api(user?`/api/users/${user.id}`:'/api/users',{method:user?'PUT':'POST',body:JSON.stringify(data)});
      closeModal();
      toast(user?'Usuário atualizado.':'Usuário cadastrado.');
      await loadUsers();
    }catch(error){toast(error.message,true);}finally{button.disabled=false;}
  };
}

async function paymentsModal(user){
  const payments=await api(`/api/users/${user.id}/subscription-payments`);
  const today=localDate();
  const month=today.slice(0,7);
  const current=payments.find(p=>p.competence.slice(0,7)===month);
  openModal(`Mensalidades: ${user.name}`,`<p>${esc(subscriptionPlans[user.subscription.plan].name)}: <strong>${money(user.subscription.monthly_amount)}/mês</strong>. Vencimento: dia ${user.subscription.due_day}.</p><p>Mês atual: <strong>${current?'Pagamento registrado':'Sem pagamento registrado'}</strong>.</p><form id="paymentForm"><div class="form-grid"><div class="field"><span>Competência (mês da mensalidade)</span><input type="month" name="competence" value="${month}" required></div><div class="field"><span>Data do pagamento</span><input type="date" name="paid_on" value="${today}" required></div><div class="field"><span>Valor recebido (R$)</span><input type="number" name="amount" min="0.01" step="0.01" max="9999999999.99" value="${esc(user.subscription.monthly_amount)}" required></div><div class="field full-row"><span>Observações do pagamento</span><textarea name="notes" maxlength="2000"></textarea></div></div><div class="form-actions"><button type="submit" class="btn primary">Registrar pagamento</button></div></form><h3>Histórico de pagamentos</h3><p class="password-help">Um registro por competência. Para corrigir um lançamento, remova e registre novamente.</p><div class="payment-history">${payments.length?payments.map(p=>`<article><strong>${esc(p.competence.slice(0,7).split('-').reverse().join('/'))}: ${money(p.amount)}</strong><span>Pago em ${esc(p.paid_on.slice(0,10).split('-').reverse().join('/'))}</span><p>${esc(p.notes)}</p><button class="btn outline" data-remove-payment="${p.id}">Remover lançamento</button></article>`).join(''):'<p>Nenhum pagamento registrado.</p>'}</div>`);
  $('#paymentForm').onsubmit=async event=>{
    event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type=submit]');button.disabled=true;
    try{await api(`/api/users/${user.id}/subscription-payments`,{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});await paymentsModal(user);toast('Pagamento registrado.');}catch(e){toast(e.message,true);}finally{button.disabled=false;}
  };
  $$('[data-remove-payment]').forEach(button=>button.onclick=async()=>{
    if(!confirm('Remover este pagamento do histórico?'))return;
    button.disabled=true;try{await api(`/api/users/${user.id}/subscription-payments/${button.dataset.removePayment}`,{method:'DELETE'});await paymentsModal(user);toast('Lançamento removido.');}catch(e){toast(e.message,true);}finally{button.disabled=false;}
  });
}

document.addEventListener('DOMContentLoaded',async()=>{
  try{
    const me=await api('/api/me');
    if(me.user.role!=='ADMIN'){location.href='/dashboard';return;}
    locations=await api('/api/locations');
    $('#newUser').onclick=()=>userModal();
    $('#userSearch').oninput=render;
    await loadUsers();
  }catch(error){toast(error.message,true);}
});
