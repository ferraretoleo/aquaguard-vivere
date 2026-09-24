let users=[];
let locations=[];
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=value=>String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

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
  $('#usersList').innerHTML=filtered.length?filtered.map(u=>`<article class="user-row"><div class="user-info"><strong>${esc(u.name)}</strong><span>${esc(u.email)}</span></div><div class="location-name">${esc(locationNames(u))}</div><div class="role-badge">${esc(roleLabels[u.role]||u.role)}</div><span class="badge ${u.is_active?'':'off'}">${u.is_active?'Ativo':'Inativo'}</span><div class="user-actions"><button class="btn outline" data-edit="${u.id}">Editar</button></div></article>`).join(''):'<div class="empty">Nenhum usuário encontrado.</div>';
  $$('[data-edit]').forEach(button=>button.onclick=()=>userModal(users.find(user=>user.id===button.dataset.edit)));
}

async function loadUsers(){users=await api('/api/users');render();}

function locationChecklist(user){
  const selected=new Set(user?.location_ids||[]);
  return locations.map(item=>`<label class="location-option"><input type="checkbox" name="location_ids" value="${item.id}" ${selected.has(item.id)?'checked':''}><span><strong>${esc(item.name)}</strong>${item.address?`<small>${esc(item.address)}</small>`:''}</span></label>`).join('');
}

function userModal(user=null){
  openModal(user?'Editar Usuário':'Novo Usuário',`<form id="userForm"><div class="form-grid"><div class="field full-row"><span>Nome *</span><input name="name" value="${esc(user?.name||'')}" required></div><div class="field full-row"><span>E-mail *</span><input name="email" type="email" value="${esc(user?.email||'')}" required></div><div class="field full-row"><span>${user?'Nova senha':'Senha *'}</span><input name="password" type="password" minlength="8" ${user?'':'required'} autocomplete="new-password"><div class="password-help">${user?'Deixe em branco para manter a senha atual.':'Use pelo menos 8 caracteres.'}</div></div><div class="field"><span>Nível de acesso</span><select name="role"><option value="USER" ${!user||user.role==='USER'?'selected':''}>Usuário</option><option value="LOCAL_ADMIN" ${user?.role==='LOCAL_ADMIN'?'selected':''}>Administrador local</option><option value="ADMIN" ${user?.role==='ADMIN'?'selected':''}>Administrador geral</option></select></div><div class="field"><span>Status</span><select name="is_active"><option value="true" ${user?.is_active!==false?'selected':''}>Ativo</option><option value="false" ${user?.is_active===false?'selected':''}>Inativo</option></select></div><div id="locationsField" class="field full-row"><span>Locais associados *</span><div class="location-checklist">${locationChecklist(user)}</div><div id="locationHelp" class="password-help"></div></div></div><div class="form-actions"><button type="button" class="btn outline" data-cancel>Cancelar</button><button class="btn primary" type="submit">${user?'Salvar alterações':'Cadastrar usuário'}</button></div></form>`);
  $('[data-cancel]').onclick=closeModal;
  const form=$('#userForm');
  const roleSelect=form.elements.role;
  const updateLocations=()=>{
    const generalAdmin=roleSelect.value==='ADMIN';
    $$('#locationsField input[type=checkbox]').forEach(input=>input.disabled=generalAdmin);
    $('#locationsField').classList.toggle('locations-disabled',generalAdmin);
    $('#locationHelp').textContent=generalAdmin?'O administrador geral vê todos os locais.':'Selecione um ou mais locais para este usuário.';
  };
  roleSelect.onchange=updateLocations;
  updateLocations();
  form.onsubmit=async event=>{
    event.preventDefault();
    const button=form.querySelector('[type=submit]');
    const role=roleSelect.value;
    const locationIds=role==='ADMIN'?[]:$$('input[name=location_ids]:checked',form).map(input=>input.value);
    if(role!=='ADMIN'&&!locationIds.length){toast('Selecione pelo menos um local.',true);return;}
    const data={name:form.elements.name.value,email:form.elements.email.value,password:form.elements.password.value,role,is_active:form.elements.is_active.value==='true',location_ids:locationIds};
    try{
      button.disabled=true;
      await api(user?`/api/users/${user.id}`:'/api/users',{method:user?'PUT':'POST',body:JSON.stringify(data)});
      closeModal();
      toast(user?'Usuário atualizado.':'Usuário cadastrado.');
      await loadUsers();
    }catch(error){toast(error.message,true);}finally{button.disabled=false;}
  };
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
