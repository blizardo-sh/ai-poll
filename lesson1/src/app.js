import {initializeApp} from 'firebase/app';
import {getAuth,signInAnonymously,onAuthStateChanged,GoogleAuthProvider,signInWithPopup,signOut,connectAuthEmulator} from 'firebase/auth';
import {getDatabase,ref,onValue,get,set,update,runTransaction,connectDatabaseEmulator} from 'firebase/database';
import {questions,prompts} from '../content.js';

const $=id=>document.getElementById(id);
const byId=Object.fromEntries(questions.map(q=>[q.id,q]));
const base='lesson1',room=`${base}/rooms/main`;
let state=null,user=null,teacher=false,online=false,busy=false,selection=null,total=0;
let db,auth,bank={},roundSubscriptions=[],unsubVotes=null,unsubState=null,authVersion=0;
let confirmedRound='',pendingVote=false,liveResults={counts:[],total:0};
const phaseNames={idle:'Скоро начнём',open:'Можно отвечать',closed:'Голосование закончено',results:'Ответы группы',explanation:'Обсуждаем ответы'};
const hasResults=s=>['open','closed','results','explanation'].includes(s?.phase);
const sameState=(a,b)=>a?.round===b?.round && a?.phase===b?.phase && a?.question===b?.question;
function message(text=''){$('message').textContent=text;}
function setBusy(value){busy=value;document.body.classList.toggle('busy',value);renderControls();}
function notice(error){
  const code=String(error?.code||error?.message||'');
  if(code.includes('popup-closed'))return;
  if(code.includes('popup-blocked'))message('Браузер заблокировал окно входа. Разрешите всплывающие окна для этой страницы и нажмите вход ещё раз.');
  else if(code.includes('unauthorized-domain'))message('Вход с этого адреса ещё не настроен. Откройте опубликованную страницу занятия.');
  else if(code.includes('permission')||code.includes('PERMISSION'))message('Действие не сохранено. Возможно, голосование уже закрыли или у аккаунта нет прав преподавателя.');
  else message('Не удалось выполнить действие. Проверьте соединение и повторите. Если проблема осталась, используйте чат встречи.');
}
function renderControls(){
  $('teacher').hidden=!teacher;$('login').hidden=teacher;$('logout').hidden=!user||user.isAnonymous;
  document.body.classList.toggle('teacher-view',teacher);
  const off=!online||busy||!teacher;
  $('start').disabled=off||state?.phase!=='idle';
  $('close').disabled=off||state?.phase!=='open';
  $('explain').disabled=off||!['closed','results'].includes(state?.phase);
  $('next').disabled=off||!state||state.phase==='open'||questions.findIndex(q=>q.id===state.question)===questions.length-1;
  ['choose','repeat'].forEach(id=>$(id).disabled=off||state?.phase==='open');
  $('new-session').disabled=off;
  $('update-prompt').disabled=off||!state||state.phase==='open'||!byId[state.question]?.promptId;
}
function renderChoices(){
  const q=byId[state?.question]; if(!q)return;
  const box=$('choices');box.className='choices'+(q.kind==='cats'?' cats':'');
  if(box.dataset.question!==q.id){
    box.replaceChildren();box.dataset.question=q.id;
    q.options.forEach((label,i)=>{
      const button=document.createElement('button');button.className='choice';button.type='button';button.setAttribute('aria-label',`${i+1}. ${label}`);
      if(q.kind==='cats'){
        const photo=document.createElement('span');photo.className='cat-photo';photo.style.setProperty('--x',`${i%3*50}%`);photo.style.setProperty('--y',`${Math.floor(i/3)*100}%`);photo.setAttribute('aria-hidden','true');button.append(photo);
      }
      const line=document.createElement('span');line.className='cat-label';const number=document.createElement('span');number.className='number';number.textContent=i+1;line.append(number);if(q.kind!=='cats'){const text=document.createElement('span');text.textContent=label;line.append(text)}const score=document.createElement('span');score.className='result-count';line.append(score);button.append(line);button.onclick=()=>vote(i);box.append(button);
    });
  }
  [...box.children].forEach((b,i)=>{b.disabled=!online||!user||state.phase!=='open'||teacher||pendingVote;b.classList.toggle('selected',selection===i);b.setAttribute('aria-pressed',selection===i?'true':'false');const n=liveResults.counts?.[i]||0;const percent=liveResults.total?Math.round(n/liveResults.total*100):0;b.querySelector('.result-count').textContent=hasResults(state)?`${n} · ${percent}%`:''});
}
function render(){
  renderControls();const q=byId[state?.question];
  if(!q){$('question').textContent='Сейчас начнём';$('hint').textContent='Вопрос появится, когда преподаватель начнёт встречу.';return;}
  document.body.classList.toggle('mood',q.kind==='cats');
  $('step').textContent=`Вопрос ${questions.indexOf(q)+1} из ${questions.length}`;
  $('phase').textContent=phaseNames[state.phase]||'';
  $('question').textContent=q.title;$('hint').textContent=q.hint;
  $('prompt-box').hidden=!q.promptId;$('prompt').textContent=state.prompt||prompts[q.promptId]||'';
  $('total').textContent=`Ответили: ${total}`;
  $('results').hidden=true;$('explanation-box').hidden=state.phase!=='explanation';
  if(teacher)$('vote-status').textContent='Вы управляете занятием.';
  else if(confirmedRound===state.round&&selection!==null)$('vote-status').textContent=state.phase==='open'?'Ответ записан. До окончания можно выбрать другой вариант.':'Ваш ответ записан.';
  else $('vote-status').textContent=state.phase==='open'?'Нажмите на вариант.':state.phase==='idle'?'Преподаватель скоро откроет голосование.':'';
  renderChoices();
}
function clearRound(){roundSubscriptions.forEach(f=>f());roundSubscriptions=[];if(unsubVotes)unsubVotes();unsubVotes=null;selection=null;confirmedRound='';total=0;liveResults={counts:[],total:0};$('bars').replaceChildren();$('explanation').textContent='';}
function drawResults(data){
  const q=byId[state?.question];if(!q||!data)return;
  $('bars').replaceChildren();const counts=data.counts||[];const n=data.total||0;
  q.options.forEach((label,i)=>{const row=document.createElement('div');row.className='bar-row';const line=document.createElement('div');line.className='bar-label';const text=document.createElement('span');text.textContent=label;const score=document.createElement('span');score.textContent=`${counts[i]||0} из ${n}`;line.append(text,score);const track=document.createElement('div');track.className='bar-track';const fill=document.createElement('div');fill.className='bar-fill';fill.style.setProperty('--percent',`${n?(counts[i]||0)/n*100:0}%`);track.append(fill);row.append(line,track);$('bars').append(row)});
}
function watchRound(s){
  clearRound();if(!user)return;
  roundSubscriptions.push(onValue(ref(db,`${room}/stats/${s.round}/total`),snap=>{total=snap.val()||0;render()},notice));
  roundSubscriptions.push(onValue(ref(db,`${room}/results/${s.round}`),snap=>{liveResults=snap.val()||{counts:[],total:0};renderChoices()},notice));
  if(!teacher)roundSubscriptions.push(onValue(ref(db,`${room}/votes/${s.round}/${user.uid}`),snap=>{if(!pendingVote){selection=snap.exists()?snap.val():null;confirmedRound=snap.exists()?s.round:'';render()}},notice));
  if(teacher){
    unsubVotes=onValue(ref(db,`${room}/votes/${s.round}`),snap=>{
      const votes=snap.val()||{};const counts=byId[s.question].options.map(()=>0);for(const v of Object.values(votes))if(Number.isInteger(v)&&v>=0&&v<counts.length)counts[v]++;
      const n=counts.reduce((a,b)=>a+b,0);
      update(ref(db,room),{[`stats/${s.round}/total`]:n,[`results/${s.round}`]:{counts,total:n}}).catch(notice);
    },notice);
  }
}
async function revealData(s){
  try{
    if(hasResults(s)){const result=await get(ref(db,`${room}/results/${s.round}`));if(state?.round===s.round)drawResults(result.val());}
    if(s.phase==='explanation'){const result=await get(ref(db,`${room}/revealed/${s.round}`));if(state?.round===s.round)$('explanation').textContent=result.val()||'';}
  }catch(e){notice(e)}
}
async function vote(choice){
  if(!online||pendingVote||teacher||state?.phase!=='open')return;
  const round=state.round;pendingVote=true;message();$('vote-status').textContent='Сохраняем ответ…';renderChoices();
  try{await set(ref(db,`${room}/votes/${round}/${user.uid}`),choice);if(state?.round===round){selection=choice;confirmedRound=round;}}
  catch(e){notice(e)}finally{pendingVote=false;render()}
}
async function change(expected,patch){
  const result=await runTransaction(ref(db,`${room}/state`),current=>sameState(current,expected)?{...current,...patch}:undefined,{applyLocally:false});
  if(!result.committed)throw new Error('State changed');
}
async function action(fn){if(busy||!online||!teacher)return;setBusy(true);message();try{await fn()}catch(e){notice(e)}finally{setBusy(false)}}
function newState(question,session){return {question,session,round:crypto.randomUUID(),phase:'idle',prompt:prompts[byId[question].promptId]||''};}
async function moveTo(question,newSession=false){
  const s=state;const next=newState(question,newSession?crypto.randomUUID():s.session);
  if(!s)await set(ref(db,`${room}/state`),next);else await change(s,next);
}
$('start').onclick=()=>action(()=>change(state,{phase:'open'}));
$('close').onclick=()=>action(async()=>{
  await change(state,{phase:'closed'});
  const s={...state};if(s.phase!=='closed')return;
  const votes=(await get(ref(db,`${room}/votes/${s.round}`))).val()||{};
  const counts=byId[s.question].options.map(()=>0);for(const v of Object.values(votes))if(Number.isInteger(v)&&v>=0&&v<counts.length)counts[v]++;
  const n=counts.reduce((a,b)=>a+b,0);await set(ref(db,`${room}/results/${s.round}`),{counts,total:n});await set(ref(db,`${room}/stats/${s.round}/total`),n);
});
$('explain').onclick=()=>action(async()=>{const s={...state};if(!bank[s.question])throw new Error('No explanation');await set(ref(db,`${room}/revealed/${s.round}`),bank[s.question]);await change(s,{phase:'explanation'});});
$('next').onclick=()=>action(()=>moveTo(questions[questions.findIndex(q=>q.id===state.question)+1].id));
$('repeat').onclick=()=>action(()=>moveTo(state.question));
$('choose').onclick=()=>action(()=>moveTo($('question-select').value));
$('new-session').onclick=()=>action(()=>moveTo('mood',true));
$('update-prompt').onclick=()=>action(()=>change(state,{prompt:$('prompt-edit').value.trim()}));
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('prompt').textContent);$('copy').textContent='Скопировано';setTimeout(()=>$('copy').textContent='Скопировать запрос',2200)}catch{const range=document.createRange();range.selectNodeContents($('prompt'));getSelection().removeAllRanges();getSelection().addRange(range);message('Текст выделен. Скопируйте его обычным способом.')}};
questions.forEach(q=>{const o=document.createElement('option');o.value=q.id;o.textContent=q.title;$('question-select').append(o)});

async function boot(){
  const config=window.POLL_CONFIG?.firebase;if(!config)throw new Error('No configuration');
  const local=location.hostname==='127.0.0.1'||location.hostname==='localhost';
  const emulator=local&&new URLSearchParams(location.search).get('emulator')==='1';
  const app=initializeApp(emulator?{...config,projectId:'demo-lesson-one',databaseURL:'https://demo-lesson-one-default-rtdb.firebaseio.com'}:config);
  auth=getAuth(app);db=getDatabase(app);
  if(emulator){connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});connectDatabaseEmulator(db,'127.0.0.1',9000);}
  $('login').onclick=async()=>{message();try{await signInWithPopup(auth,new GoogleAuthProvider())}catch(e){notice(e)}};
  $('logout').onclick=async()=>{message();try{await signOut(auth);await signInAnonymously(auth)}catch(e){notice(e)}};
  onValue(ref(db,'.info/connected'),snap=>{online=snap.val()===true;$('connection').textContent=online?'На связи':'Нет соединения. Голосование временно недоступно.';$('connection').classList.toggle('offline',!online);render()},notice);
  onAuthStateChanged(auth,async account=>{
    const version=++authVersion;clearRound();if(unsubState)unsubState();unsubState=null;user=account;teacher=false;bank={};renderControls();
    if(!account){try{await signInAnonymously(auth)}catch(e){notice(e)}return;}
    if(!account.isAnonymous){try{teacher=(await get(ref(db,`${base}/teacherAccess`))).val()===true;if(teacher)bank=(await get(ref(db,`${base}/explanations`))).val()||{};}catch{message('Вы вошли, но у этого аккаунта нет прав преподавателя. Можно участвовать в голосовании.');}}
    if(version!==authVersion)return;
    unsubState=onValue(ref(db,`${room}/state`),snap=>{
      const s=snap.val();if(!s){state=null;render();return;}
      const roundChanged=state?.round!==s.round;
      const questionChanged=state?.question!==s.question;
      const promptChanged=state?.prompt!==s.prompt;
      const phaseChanged=state?.phase!==s.phase;
      state=s;if(roundChanged||roundSubscriptions.length===0){watchRound(s);if(questionChanged)$('question-select').value=s.question;$('prompt-edit').value=s.prompt||'';$('prompt-details').open=!!byId[s.question]?.promptId;message();}
      else if(promptChanged)$('prompt-edit').value=s.prompt||'';
      render();if(roundChanged||phaseChanged)revealData(s);
    },notice);
  });
}
boot().catch(notice);
