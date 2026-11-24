export const adminPage = String.raw`<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>پنل PARSCLOUD</title>
<style>
body{margin:0;background:#f2f5fa;color:#172238;font-family:Tahoma,Arial,sans-serif}
header{background:#111d38;color:white;padding:20px;font-size:22px;font-weight:bold}
main{max-width:1000px;margin:20px auto;padding:0 14px}
.card{background:white;border:1px solid #e1e7f0;border-radius:14px;padding:18px;margin-bottom:14px}
h2{font-size:17px;margin-top:0}label{display:block;font-size:13px;margin:10px 0 6px}
input,select,button{font:inherit;padding:10px;border-radius:9px;border:1px solid #d1d9e6}
input,select{width:100%;box-sizing:border-box}button{cursor:pointer;background:#176b59;color:white;border:0;font-size:12px;margin:4px}
button.secondary{background:#273653}button.danger{background:#a62b2b}
.grid{display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:10px}
.notice{padding:12px;background:#e8f8f0;margin-top:10px;border-radius:8px;overflow-wrap:anywhere}
.err{background:#fff0ef;color:#a62b2b}.muted{font-size:12px;color:#69758b;line-height:1.8}
.key{direction:ltr;word-break:break-all;background:#f2f5fa;padding:10px}
.wrap{overflow:auto}table{border-collapse:collapse;width:100%;min-width:760px}
th,td{text-align:right;border-bottom:1px solid #edf0f5;padding:10px;font-size:12px}
#devicePanel{border:1px solid #d9e2ee;border-radius:10px;padding:12px;margin-top:14px}
@media(max-width:700px){.grid{grid-template-columns:1fr 1fr}}@media(max-width:420px){.grid{grid-template-columns:1fr}}
</style></head>
<body>
<header>PARS<span style="color:#67dfbd">CLOUD</span> · پنل مدیریت</header>
<main>
<section class="card" id="login">
<h2>ورود مدیر</h2><p class="muted">توکن مدیریتی را وارد کن؛ فقط تا زمان باز بودن این صفحه در حافظه می‌ماند.</p>
<form id="lf"><label>توکن مدیریتی</label><input id="token" type="password" minlength="32" required><button>ورود</button></form><div id="lm"></div>
</section>
<div id="app" hidden>
<section class="card">
<h2>ساخت اشتراک</h2>
<form id="cf">
<div class="grid">
<div><label>نام مشتری / شناسه</label><input id="customer" maxlength="120" required placeholder="مثلاً علی - تلگرام"></div>
<div><label>مدت</label><select id="duration"><option value="30">۳۰ روز</option><option value="60">۶۰ روز</option><option value="90">۹۰ روز</option><option value="180">۱۸۰ روز</option><option value="365">۳۶۵ روز</option></select></div>
<div><label>مدت دلخواه (اختیاری)</label><input id="custom" type="number" min="1" max="3650" placeholder="۴۵"></div>
<div><label>حداکثر دستگاه (۱ تا ۱۰۰)</label><input id="maxDevices" type="number" min="1" max="100" value="1" required></div>
</div>
<button id="cb">ساخت اشتراک</button></form>
<div id="created"></div><p class="muted">کلید کامل فقط یک بار نمایش داده می‌شود؛ آن را همان لحظه کپی کن. تعداد دستگاه‌ها فقط نصب‌های اپ را محدود می‌کند، نه اتصال‌های هم‌زمان یا تعداد کانفیگ‌ها.</p>
</section>
<section class="card">
<h2>اشتراک‌ها <button id="refresh">تازه‌سازی</button> <button id="logout" class="secondary">خروج</button></h2>
<input id="search" placeholder="جست‌وجوی مشتری یا کلید"><p id="counts" class="muted"></p>
<div class="wrap"><table><thead><tr><th>مشتری</th><th>وضعیت</th><th>دستگاه‌ها</th><th>انقضا</th><th>پیشوند کلید</th><th>عملیات</th></tr></thead><tbody id="rows"></tbody></table></div>
<div id="lm2"></div>
<div id="devicePanel" hidden>
<h3 id="deviceTitle">دستگاه‌های ثبت‌شده</h3><p id="deviceSummary" class="muted"></p>
<div class="wrap"><table><thead><tr><th>شناسه دستگاه</th><th>اولین ثبت</th><th>آخرین فعالیت</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody id="deviceRows"></tbody></table></div>
</div>
</section>
</div></main>
<script>
(function(){
let token="",items=[],selectedSubscriptionId="";
const $=id=>document.getElementById(id);
const esc=value=>String(value==null?"":value).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const date=value=>new Date(value).toLocaleDateString("fa-IR");
const msg=(id,value,err)=>{$(id).innerHTML=value?'<div class="notice '+(err?"err":"")+'">'+value+"</div>":""};
async function api(path,options){
 const response=await fetch(path,Object.assign({},options||{},{headers:Object.assign({"Authorization":"Bearer "+token,"Content-Type":"application/json"},options&&options.headers||{})}));
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(data.error||"درخواست انجام نشد");
 return data;
}
async function load(){
 try{items=(await api("/admin/subscriptions?limit=100")).subscriptions||[];render();msg("lm2","");}
 catch(error){msg("lm2",esc(error.message),true);}
}
function render(){
 const query=$("search").value.toLocaleLowerCase();
 const filtered=items.filter(item=>(item.customerLabel+" "+item.keyPrefix).toLocaleLowerCase().includes(query));
 $("counts").textContent="کل: "+items.length+" | فعال: "+items.filter(item=>item.status==="active").length;
 $("rows").innerHTML=filtered.map(item=>'<tr><td>'+esc(item.customerLabel)+'</td><td>'+({"active":"فعال","expired":"منقضی","revoked":"لغوشده"}[item.status]||esc(item.status))+'</td><td>'+esc(item.registeredDevices)+' / '+esc(item.maxDevices)+'</td><td>'+esc(date(item.expiresAt))+'</td><td dir="ltr">'+esc(item.keyPrefix)+'…</td><td><button data-d="'+esc(item.id)+'">دستگاه‌ها</button><button data-l="'+esc(item.id)+'" class="secondary">تغییر سقف</button>'+(item.status==="revoked"?"":'<button data-r="'+esc(item.id)+'">تمدید</button><button data-v="'+esc(item.id)+'" class="danger">لغو</button>')+'</td></tr>').join("")||'<tr><td colspan="6">موردی پیدا نشد.</td></tr>';
}
$("lf").onsubmit=async event=>{
 event.preventDefault();token=$("token").value.trim();
 try{await api("/admin/subscriptions?limit=1");$("login").hidden=true;$("app").hidden=false;await load();}
 catch(error){token="";msg("lm",esc(error.message),true);}
};
$("cf").onsubmit=async event=>{
 event.preventDefault();
 const days=Number($("custom").value||$("duration").value),limit=Number($("maxDevices").value),label=$("customer").value.trim();
 if(!Number.isInteger(days)||days<1||days>3650){msg("created","مدت باید بین ۱ تا ۳۶۵۰ روز باشد.",true);return;}
 if(!Number.isInteger(limit)||limit<1||limit>100){msg("created","حداکثر دستگاه باید عددی بین ۱ تا ۱۰۰ باشد.",true);return;}
 $("cb").disabled=true;
 try{
  const subscription=(await api("/admin/subscriptions",{method:"POST",body:JSON.stringify({customerLabel:label,durationDays:days,maxDevices:limit})})).subscription;
  msg("created",'<b>اشتراک ساخته شد.</b><p>'+esc(subscription.customerLabel)+' · انقضا: '+esc(date(subscription.expiresAt))+' · سقف دستگاه: '+esc(subscription.maxDevices)+'</p><div class="key">'+esc(subscription.subscriptionKey)+'</div><button id="copy" type="button">کپی کلید</button>');
  $("copy").onclick=async()=>{try{await navigator.clipboard.writeText(subscription.subscriptionKey);$("copy").textContent="کپی شد";}catch(error){msg("created","کپی خودکار نشد؛ کلید را دستی کپی کن.",true);}};
  $("customer").value="";$("custom").value="";await load();
 }catch(error){msg("created",esc(error.message),true);}
 finally{$("cb").disabled=false;}
};
async function showDevices(id){
 selectedSubscriptionId=id;
 const item=items.find(value=>value.id===id);
 $("devicePanel").hidden=false;
 $("deviceTitle").textContent="دستگاه‌های ثبت‌شده · "+(item?item.customerLabel:"");
 $("deviceRows").innerHTML='<tr><td colspan="5">در حال دریافت…</td></tr>';
 try{
  const result=await api("/admin/subscriptions/"+id+"/devices");
  $("deviceSummary").textContent="دستگاه فعال: "+result.registeredDevices+" از "+result.maxDevices+" · اگر سقف را کمتر از تعداد فعلی تنظیم کنی، دستگاه‌های فعلی حذف نمی‌شوند و فقط ثبت دستگاه جدید متوقف می‌شود.";
  $("deviceRows").innerHTML=result.devices.map(device=>'<tr><td dir="ltr">'+esc(device.fingerprint)+'</td><td>'+esc(date(device.createdAt))+'</td><td>'+esc(date(device.lastSeenAt))+'</td><td>'+(device.revoked?"حذف‌شده":"فعال")+'</td><td>'+(device.revoked?"—":'<button class="danger" data-remove="'+esc(device.id)+'">حذف دستگاه</button>')+'</td></tr>').join("")||'<tr><td colspan="5">هنوز دستگاهی ثبت نشده است.</td></tr>';
 }catch(error){$("deviceRows").innerHTML='<tr><td colspan="5">'+esc(error.message)+'</td></tr>';}
}
$("rows").onclick=async event=>{
 const target=event.target.closest("button");if(!target)return;
 try{
  if(target.dataset.d){await showDevices(target.dataset.d);return;}
  if(target.dataset.l){
   const item=items.find(value=>value.id===target.dataset.l);if(!item)return;
   const next=Number(prompt("حداکثر تعداد دستگاه برای این اشتراک (۱ تا ۱۰۰):",String(item.maxDevices)));
   if(!Number.isInteger(next)||next<1||next>100)return;
   const result=await api("/admin/subscriptions/"+item.id+"/device-limit",{method:"POST",body:JSON.stringify({maxDevices:next})});
   msg("lm2","سقف دستگاه به "+result.maxDevices+" تغییر کرد. دستگاه‌های ثبت‌شده حذف نشدند؛ دستگاه جدید فقط در صورت وجود ظرفیت پذیرفته می‌شود.");
  }else if(target.dataset.r){
   const days=Number(prompt("چند روز تمدید؟","30"));if(!Number.isInteger(days)||days<1||days>3650)return;
   await api("/admin/subscriptions/"+target.dataset.r+"/renew",{method:"POST",body:JSON.stringify({durationDays:days})});
  }else if(target.dataset.v){
   const item=items.find(value=>value.id===target.dataset.v);if(!item||!confirm("اشتراک "+item.customerLabel+" لغو شود؟"))return;
   await api("/admin/subscriptions/"+target.dataset.v+"/revoke",{method:"POST",body:"{}"});
  }
  await load();
  if(selectedSubscriptionId)await showDevices(selectedSubscriptionId);
 }catch(error){msg("lm2",esc(error.message),true);}
};
$("deviceRows").onclick=async event=>{
 const button=event.target.closest("[data-remove]");if(!button)return;
 if(!confirm("این دستگاه حذف شود و ظرفیت آن آزاد شود؟"))return;
 try{await api("/admin/subscriptions/"+selectedSubscriptionId+"/devices/"+button.dataset.remove,{method:"DELETE"});await showDevices(selectedSubscriptionId);await load();}
 catch(error){msg("lm2",esc(error.message),true);}
};
$("refresh").onclick=load;$("search").oninput=render;
$("logout").onclick=()=>{token="";items=[];$("token").value="";$("app").hidden=true;$("login").hidden=false;$("devicePanel").hidden=true;msg("lm","از پنل خارج شدی");};
})();
</script></body></html>`;
