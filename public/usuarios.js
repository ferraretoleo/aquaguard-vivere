let users=[];
let locations=[];
const $=(s,r=document)=>r.querySelector(s);
const esc=value=>String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

async function api(url,options={}){
  const response=await fetch(url,{credentials:'same-origin',...options,headers:{'content-type':'application/json',...(options.headers||{})}});
  if(response.status===401){location.href='/login?from=/usuarios';throw new Error('Entre novamente.');}
  if(response.status===403){location.href='/dashboard';throw new Error('Acesso exclusivo para administrador.');}
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Não foi possível concluir.');
  return data;
}

function toast(message,error=false){const el=$('#toast');el.textContent=message;el.className=`toast show${error?' error':''}`;clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className='toast',3200);}
function closeModal(){$('#modalRoot').innerHTML='';}
function openModal(title,body){$('#modalRoot').innerHTML=`<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>${esc(title)}</h2><button class="modal-close" data-close aria-label="Fechar">×</button></div><div class="modal-body">${body}</div></section></div>`;$('[data-close]').onclick=closeModal;$('.modal-backdrop').onclick=e=>{if(e.target===e.currentTarget)closeModal();};}

function render(){
  const term=$('#userSearch').value.trim().toLowerCase();
  const filtered=users.filter(u=>`${u.name} ${u.email} ${u.location_name}`.toLowerCase().includes(term));
  $('#userCount').textContent=`${filtered.length} usuário(s)`;
  $('#usersList').innerHTML=filtered.length?filtered.map(u=>`<article class="user-row"><div class="user-info"><strong>${esc(u.name)}</strong><span>${esc(u.email)}</span></div><div class="location-name">${esc(u.location_name)}</div><div class="role-badge">${u.role==='ADMIN'?'Administrador':'Usuário'}</div><span class="badge ${u.is_active?'':'off'}">${u.is_active?'Ativo':'Inativo'}</span><div class="user-actions"><button class="btn outline" data-edit="${u.id}">Editar</button></div></article>`).join(''):'<div class="empty">Nenhum usuário encontrado.</div>';
  document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>userModal(users.find(u=>u.id===b.dataset.edit)));
}

async function loadUsers(){users=await api('/api/users');render();}

function userModal(user=null){
  openModal(user?'Editar Usuário':'Novo Usuário',`<form id="userForm"><div class="form-grid"><div class="field full-row"><span>Local *</span><select name="location_id" required><option value="">Selecione o local</option>${locations.map(l=>`<option value="${l.id}" ${l.id===user?.location_id?'selected':''}>${esc(l.name)}</option>`).join('')}</select></div><div class="field full-row"><span>Nome *</span><input name="name" value="${esc(user?.name||'')}" required></div><div class="field full-row"><span>E-mail *</span><input name="email" type="email" value="${esc(user?.email||'')}" required></div><div class="field full-row"><span>${user?'Nova senha':'Senha *'}</span><input name="password" type="password" minlength="8" ${user?'':'required'} autocomplete="new-password"><div class="password-help">${user?'Deixe em branco para manter a senha atual.':'Use pelo menos 8 caracteres.'}</div></div><div class="field"><span>Nível de acesso</span><select name="role"><option value="USER" ${user?.role!=='ADMIN'?'selected':''}>Usuário do local</option><option value="ADMIN" ${user?.role==='ADMIN'?'selected':''}>Administrador geral</option></select></div><div class="field"><span>Status</span><select name="is_active"><option value="true" ${user?.is_active!==false?'selected':''}>Ativo</option><option value="false" ${user?.is_active===false?'selected':''}>Inativo</option></select></div></div><div class="form-actions"><button type="button" class="btn outline" data-cancel>Cancelar</button><button class="btn primary" type="submit">${user?'Salvar alterações':'Cadastrar usuário'}</button></div></form>`);
  $('[data-cancel]').onclick=closeModal;
  $('#userForm').onsubmit=async e=>{e.preventDefault();const button=e.currentTarget.querySelector('[type=submit]');const data=Object.fromEntries(new FormData(e.currentTarget));data.is_active=data.is_active==='true';try{button.disabled=true;await api(user?`/api/users/${user.id}`:'/api/users',{method:user?'PUT':'POST',body:JSON.stringify(data)});closeModal();toast(user?'Usuário atualizado.':'Usuário cadastrado.');await loadUsers();}catch(error){toast(error.message,true);}finally{button.disabled=false;}};
}

document.addEventListener('DOMContentLoaded',async()=>{
  try{const me=await api('/api/me');if(me.user.role!=='ADMIN'){location.href='/dashboard';return;}locations=await api('/api/locations');$('#newUser').onclick=()=>userModal();$('#userSearch').oninput=render;await loadUsers();}catch(error){toast(error.message,true);}
});
