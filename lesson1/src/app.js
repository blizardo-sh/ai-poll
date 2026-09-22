import {initializeApp} from 'firebase/app';
import {getAuth,signInAnonymously,onAuthStateChanged,connectAuthEmulator} from 'firebase/auth';
import {getDatabase,ref,onValue,get,set,runTransaction,connectDatabaseEmulator} from 'firebase/database';
import {questions,prompts} from '../content.js';

const $=id=>document.getElementById(id);
const byId=Object.fromEntries(questions.map(q=>[q.id,q]));
const isDeckBridge=window.parent!==window&&new URLSearchParams(location.search).get('bridge')==='1';
const base='lesson1',room=`${base}/rooms/main`;
let state=null,user=null,online=false,busy=false,selection=null,total=0;
let db,auth,roundSubscriptions=[],unsubState=null;
let votesLoaded=false,stateLoaded=false;
let confirmedRound='',pendingVote=false,liveResults={counts:[],total:0};
const phaseNames={idle:'Скоро начнём',open:'Можно отвечать',closed:'Голосование закончено',results:'Ответы группы',explanation:'Обсуждаем ответы'};
const hasResults=s=>['open','closed','results','explanation'].includes(s?.phase);
const sameState=(a,b)=>a?.round===b?.round && a?.phase===b?.phase && a?.question===b?.question;
function message(text=''){$('message').textContent=text;postDeckSnapshot();}
function setBusy(value){busy=value;document.body.classList.toggle('busy',value);renderControls();}
function notice(error){
  const code=String(error?.code||error?.message||'');
  if(code.includes('permission')||code.includes('PERMISSION'))message('Действие не сохранено. Возможно, вопрос уже сменился или голосование закончилось. Обновите страницу и повторите.');
  else message('Не удалось выполнить действие. Проверьте соединение и повторите. Если проблема осталась, используйте чат встречи.');
}
function renderControls(){
  const off=!online||busy||!user;
  $('start').disabled=off||state?.phase!=='idle';
  $('close').disabled=off||state?.phase!=='open';
  $('explain').disabled=off||!['open','closed','results'].includes(state?.phase);
  $('next').disabled=off||!state||state.phase==='open'||questions.findIndex(q=>q.id===state.question)===questions.length-1;
  ['choose','repeat'].forEach(id=>$(id).disabled=off||state?.phase==='open');
  $('new-session').disabled=off;
  $('update-prompt').disabled=off||!state||state.phase==='open'||!byId[state.question]?.promptId;
  postDeckSnapshot();
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
  [...box.children].forEach((b,i)=>{b.disabled=!online||!user||state.phase!=='open'||pendingVote;b.classList.toggle('selected',selection===i);b.setAttribute('aria-pressed',selection===i?'true':'false');const n=liveResults.counts?.[i]||0;const percent=liveResults.total?Math.round(n/liveResults.total*100):0;b.querySelector('.result-count').textContent=hasResults(state)?`${n} · ${percent}%`:''});
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
  $('explanation-box').hidden=state.phase!=='explanation';
  if(confirmedRound===state.round&&selection!==null)$('vote-status').textContent=state.phase==='open'?'Ответ записан. До окончания можно выбрать другой вариант.':'Ваш ответ записан.';
  else $('vote-status').textContent=state.phase==='open'?'Нажмите на вариант.':state.phase==='idle'?'Преподаватель скоро откроет голосование.':'';
  renderChoices();
}
function clearRound(){
  roundSubscriptions.forEach(unsubscribe=>unsubscribe());roundSubscriptions=[];
  votesLoaded=false;selection=null;confirmedRound='';total=0;liveResults={counts:[],total:0};$('explanation').textContent='';
}
function watchRound(s){
  clearRound();if(!user)return;
  roundSubscriptions.push(onValue(ref(db,`${room}/votes/${s.round}`),snap=>{
    if(state?.round!==s.round)return;
    const votes=snap.val()||{};const counts=byId[s.question].options.map(()=>0);
    for(const choice of Object.values(votes))if(Number.isInteger(choice)&&choice>=0&&choice<counts.length)counts[choice]++;
    total=counts.reduce((sum,count)=>sum+count,0);liveResults={counts,total};votesLoaded=true;
    if(!pendingVote){selection=votes[user.uid]??null;confirmedRound=selection===null?'':s.round;}
    render();
  },error=>{if(state?.round===s.round)notice(error)}));
}
async function revealData(s){
  if(s.phase!=='explanation')return;
  try{const result=await get(ref(db,`${room}/revealed/${s.round}`));if(state?.round===s.round&&state.phase==='explanation'){$('explanation').textContent=result.val()||'';postDeckSnapshot();}}
  catch(error){if(state?.round===s.round)notice(error)}
}
async function vote(choice){
  if(!online||!user||pendingVote||state?.phase!=='open')return;
  const round=state.round;pendingVote=true;message();$('vote-status').textContent='Сохраняем ответ…';renderChoices();
  try{await set(ref(db,`${room}/votes/${round}/${user.uid}`),choice);if(state?.round===round){selection=choice;confirmedRound=round;}}
  catch(e){notice(e)}finally{pendingVote=false;render()}
}
async function change(expected,patch){
  const result=await runTransaction(ref(db,`${room}/state`),current=>sameState(current,expected)?{...current,...patch}:undefined,{applyLocally:false});
  if(!result.committed)throw new Error('State changed');
}
async function action(fn){if(busy||!online||!user)return false;setBusy(true);message();try{await fn();return true}catch(e){notice(e);return false}finally{setBusy(false)}}
function newState(question,session){return {question,session,round:crypto.randomUUID(),phase:'idle',prompt:prompts[byId[question].promptId]||''};}
async function moveTo(question,newSession=false){
  const s=state;const next=newState(question,newSession?crypto.randomUUID():(s?.session||crypto.randomUUID()));
  if(!s)await set(ref(db,`${room}/state`),next);else await change(s,next);
}
$('start').onclick=()=>action(()=>change(state,{phase:'open'}));
$('close').onclick=()=>action(()=>change(state,{phase:'closed'}));
async function showExplanation(){
  const s={...state};const explanation=(await get(ref(db,`${base}/explanations/${s.question}`))).val();
  if(!explanation)throw new Error('No explanation');
  await set(ref(db,`${room}/revealed/${s.round}`),explanation);
  await change(s,{phase:'explanation'});
}
$('explain').onclick=()=>action(showExplanation);
$('next').onclick=()=>action(()=>moveTo(questions[questions.findIndex(q=>q.id===state.question)+1].id));
$('repeat').onclick=()=>action(()=>moveTo(state.question));
$('choose').onclick=()=>action(()=>moveTo($('question-select').value));
$('new-session').onclick=()=>action(()=>moveTo('mood',true));
$('update-prompt').onclick=()=>action(()=>change(state,{prompt:$('prompt-edit').value.trim()}));
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('prompt').textContent);$('copy').textContent='Скопировано';setTimeout(()=>$('copy').textContent='Скопировать запрос',2200)}catch{const range=document.createRange();range.selectNodeContents($('prompt'));getSelection().removeAllRanges();getSelection().addRange(range);message('Текст выделен. Скопируйте его обычным способом.')}};
questions.forEach(q=>{const o=document.createElement('option');o.value=q.id;o.textContent=q.title;$('question-select').append(o)});

// Physical keys work with both Russian and English keyboard layouts.
addEventListener('keydown',event=>{
  if(event.repeat||event.isComposing||event.ctrlKey||event.metaKey||event.altKey||event.target.closest('input,textarea,select,[contenteditable="true"]'))return;
  const key=event.code||({s:'KeyS','ы':'KeyS',c:'KeyC','с':'KeyC',o:'KeyO','щ':'KeyO',n:'KeyN','т':'KeyN'}[event.key.toLowerCase()]);
  const id={KeyS:'start',KeyC:'close',KeyO:'explain',KeyN:'next'}[key];
  if(id&&!$(id).disabled){event.preventDefault();$(id).click();}
});

// Only aggregate results are sent to the presentation. No tokens or voter IDs leave this frame.
function postDeckSnapshot(){
  if(!isDeckBridge)return;
  window.parent.postMessage({type:'lesson1:snapshot',ready:online&&!!user&&stateLoaded&&(!state||votesLoaded),online,busy,
    question:state?.question||'',phase:state?.phase||'',round:state?.round||'',session:state?.session||'',
    counts:liveResults.counts,total:liveResults.total,explanation:state?.phase==='explanation'?$('explanation').textContent:'',error:$('message').textContent},'*');
}
addEventListener('message',async event=>{
  if(!isDeckBridge||event.source!==window.parent)return;
  const data=event.data;
  if(!data||data.type!=='lesson1:command'||!['snapshot','start','close','explain'].includes(data.action))return;
  if(data.action==='snapshot'){postDeckSnapshot();return;}
  if(typeof data.id!=='string'||data.id.length>80||!byId[data.question])return;
  const ok=await action(async()=>{
    const s=state;
    if(data.action==='start'){
      if(s?.question===data.question&&s.phase==='open')return;
      if(s?.question===data.question&&s.phase==='idle')await change(s,{phase:'open'});
      else {const next={...newState(data.question,s?.session||crypto.randomUUID()),phase:'open'};if(s)await change(s,next);else await set(ref(db,`${room}/state`),next);}
    }else{
      if(s?.question!==data.question)throw new Error('Question changed');
      if(data.action==='close'){if(s.phase!=='open')throw new Error('Voting is closed');await change(s,{phase:'closed'});}
      else {if(!['open','closed','results'].includes(s.phase))throw new Error('No voting to explain');await showExplanation();}
    }
  });
  window.parent.postMessage({type:'lesson1:command-result',id:data.id,ok,error:ok?'':$('message').textContent||'Действие не выполнено. Проверьте соединение.'},'*');
});

async function boot(){
  const config=window.POLL_CONFIG?.firebase;if(!config)throw new Error('No configuration');
  const local=location.hostname==='127.0.0.1'||location.hostname==='localhost';
  const emulator=local&&new URLSearchParams(location.search).get('emulator')==='1';
  const app=initializeApp(emulator?{...config,projectId:'demo-lesson-one',databaseURL:'https://demo-lesson-one-default-rtdb.firebaseio.com'}:config);
  auth=getAuth(app);db=getDatabase(app);
  if(emulator){connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});connectDatabaseEmulator(db,'127.0.0.1',9000);}
  onValue(ref(db,'.info/connected'),snap=>{online=snap.val()===true;$('connection').textContent=online?'На связи':'Нет соединения. Голосование временно недоступно.';$('connection').classList.toggle('offline',!online);render()},notice);
  onAuthStateChanged(auth,async account=>{
    stateLoaded=false;
    clearRound();if(unsubState)unsubState();unsubState=null;user=account;renderControls();
    if(!account){try{await signInAnonymously(auth)}catch(e){notice(e)}return;}
    unsubState=onValue(ref(db,`${room}/state`),snap=>{
      stateLoaded=true;
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
