const DEPARTMENTS = ['ネットワーク1G','ネットワーク2G','管理G','技術G','建設1G','建設2G','建設3G','通信事業部','保全G','横浜営業所','埼玉営業所','大阪営業所','広島営業所'];
const MODELS = [['hiace','ハイエース'],['hijet','ハイゼット'],['succeed','サクシード'],['probox','プロボックス'],['toyoace','トヨエース']];
const CHECKS = ['brakes','tires','engine','battery','lights','washer','wipers','glass','body'];
const DEMO_EMPLOYEE = Object.freeze({id:'1001',name:'デモ運転者'});
const copy = value => structuredClone(value);
const failure = (code, message) => Object.assign(new Error(message), {code, ambiguous:false});
function requireValue(ok, message, code='VALIDATION_ERROR') { if(!ok) throw failure(code,message); }
function reading(value) { if(value===null || value==='' || value===undefined) return null; const n=Number(value); requireValue(Number.isFinite(n)&&n>=0,'測定値を確認してください。'); return n; }
function dateOnly(date) { return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Tokyo'}).format(date); }

export function createDemoApi(env=globalThis, {clock=()=>new Date()}={}) {
  const storageKey='drivelog.demo.v1';
  let state={trips:[],receipts:[],oil:{}};
  try { const saved=JSON.parse(env.localStorage?.getItem(storageKey)||'null'); if(saved&&Array.isArray(saved.trips)&&Array.isArray(saved.receipts)) state={...saved,oil:saved.oil&&typeof saved.oil==='object'?saved.oil:{}}; } catch { /* use clean demo */ }
  const persist=()=>{try{env.localStorage?.setItem(storageKey,JSON.stringify(state));}catch{/* memory-only preview */}};
  const now=()=>new Date(clock());
  const seedNow=now();
  const vehicles=Array.from({length:48},(_,i)=>{
    const [modelKey,model]=MODELS[i%MODELS.length];
    const due=new Date(seedNow); due.setDate(due.getDate()+[80,50,20,200,300][i%5]);
    return {id:'sample-'+String(i+1).padStart(2,'0'),number:'サンプル400あ'+String(i+1).padStart(2,'0'),model,modelKey,fuelType:i%3===1?'軽油':'ガソリン',inspectionDue:dateOnly(due),currentOdometer:i===47?null:120000+i*1000,requiresClutch:i%5===4};
  });
  const vehicleFor=id=>{const vehicle=vehicles.find(v=>v.id===id);requireValue(vehicle,'車両を選択してください。','VEHICLE_NOT_FOUND');return vehicle;};
  const contextFor=(id,source=state)=>{
    const vehicle=copy(vehicleFor(id));
    const completed=source.trips.filter(t=>t.vehicleId===id&&t.status==='completed').sort((a,b)=>new Date(b.completedAt)-new Date(a.completedAt));
    const startOdometer=completed.length?completed[0].endOdometer:vehicle.currentOdometer;
    vehicle.currentOdometer=startOdometer;
    const activeTrip=source.trips.find(t=>t.vehicleId===id&&t.status==='active')||null;
    const interval=vehicle.fuelType==='軽油'?4000:7000;
    const index=vehicles.findIndex(v=>v.id===id);
    const baseline=Object.hasOwn(source.oil,id)?source.oil[id]:(index%5===4?null:(vehicleFor(id).currentOdometer===null?null:vehicleFor(id).currentOdometer-(interval-(index===0?40:2500))));
    const remaining=baseline===null||startOdometer===null?null:interval-(startOdometer-baseline);
    const oil={baseline,interval,remaining,status:remaining===null?'unregistered':remaining<=0?'overdue':remaining<50?'warning':'ok'};
    const warnings=[];
    if(oil.status==='warning'||oil.status==='overdue') warnings.push({id:'oil-'+id+'-'+oil.status,type:'oil',level:oil.status==='overdue'?'danger':'warning',title:oil.status==='overdue'?'オイル交換の目安を超えています':'オイル交換の時期が近づいています',message:oil.status==='overdue'?'前回の交換からの距離を確認し、オイル交換をお願いします。':'交換の目安まで残り'+remaining+'kmです。'});
    const due=new Date(vehicle.inspectionDue+'T00:00:00+09:00');
    const limit=new Date(now());limit.setMonth(limit.getMonth()+3);
    if(due<=limit) warnings.push({id:'inspection-'+id,type:'inspection',level:due<now()?'danger':'warning',title:due<now()?'車検満了日を過ぎています':'車検満了日が近づいています',message:'車検満了日：'+vehicle.inspectionDue});
    return {vehicle,activeTrip:activeTrip?copy(activeTrip):null,oil,warnings,startOdometer};
  };
  const mutation=(action,payload,id,work)=>{
    requireValue(typeof id==='string'&&id.length>0,'保存内容を確認できません。','VALIDATION_ERROR');
    const fingerprint=JSON.stringify({action,payload});
    const old=state.receipts.find(r=>r.id===id);
    if(old){requireValue(old.fingerprint===fingerprint,'同じ送信番号で内容が変更されています。','REQUEST_ID_REUSED');return copy(old.result);}
    const next=copy(state); const result=work(next);
    next.receipts.push({id,fingerprint,result:copy(result)}); next.receipts=next.receipts.slice(-200);state=next;persist();return copy(result);
  };
  return {
    launchContext:{employeeId:DEMO_EMPLOYEE.id,department:''},
    async bootstrap(){return {employee:copy(DEMO_EMPLOYEE),departments:[...DEPARTMENTS],vehicles:vehicles.map(v=>contextFor(v.id).vehicle),serverTime:now().toISOString()};},
    async vehicleContext(id){return contextFor(id);},
    async startTrip(payload,id){return mutation('startTrip',payload,id,next=>{
      const ctx=contextFor(payload.vehicleId,next); const employee=DEMO_EMPLOYEE;
      requireValue(payload.employeeId===undefined||payload.employeeId===null||payload.employeeId===''||String(payload.employeeId)===employee.id,'キンジロー君で認証された運転者と一致しません。','EMPLOYEE_MISMATCH');
      requireValue(DEPARTMENTS.includes(payload.department),'稼働部門を選択してください。');
      requireValue(ctx.startOdometer!==null,'出発メーターが未登録です。','INITIAL_ODOMETER_REQUIRED');
      requireValue(!ctx.activeTrip,'この車両には運転中の記録があります。','VEHICLE_IN_USE');
      requireValue(CHECKS.every(key=>payload.checks?.[key]===true)&&(!ctx.vehicle.requiresClutch||payload.checks?.clutch===true),'対象の点検項目をすべて確認してください。','VALIDATION_ERROR');
      requireValue(['有','無'].includes(payload.before?.presence),'酒気帯びの有無を選択してください。');
      const trip={id:'demo-'+id,vehicleId:ctx.vehicle.id,vehicleNumber:ctx.vehicle.number,model:ctx.vehicle.model,modelKey:ctx.vehicle.modelKey,employeeId:employee.id,employeeName:employee.name,department:payload.department,startedAt:now().toISOString(),startOdometer:ctx.startOdometer,before:{confirmed:payload.before.confirmed===true,reading:reading(payload.before.reading),presence:payload.before.presence},status:'active'};
      next.trips.push(trip);return {trip};
    });},
    async finishTrip(payload,id){return mutation('finishTrip',payload,id,next=>{
      const trip=next.trips.find(t=>t.id===payload.tripId);requireValue(trip,'運転中の記録が見つかりません。','TRIP_NOT_FOUND');
      requireValue(trip.status==='active','この記録は完了済みです。','TRIP_ALREADY_COMPLETED');
      const end=Number(payload.endOdometer);requireValue(Number.isFinite(end)&&end>=trip.startOdometer&&payload.endOdometer!==''&&payload.endOdometer!==null,'終了メーターは出発メーター以上の値を入力してください。','ODOMETER_DECREASE');
      requireValue(typeof payload.destination==='string'&&payload.destination.trim(),'行き先を入力してください。');
      const liters=payload.refueled?Number(payload.fuelLiters):null;requireValue(!payload.refueled||(Number.isFinite(liters)&&liters>0),'給油量を入力してください。','VALIDATION_ERROR');
      requireValue(['有','無'].includes(payload.after?.presence),'酒気帯びの有無を選択してください。');
      Object.assign(trip,{destination:payload.destination.trim(),completedAt:now().toISOString(),endOdometer:end,distance:Math.round((end-trip.startOdometer)*10)/10,refueled:payload.refueled===true,fuelLiters:liters,oilChanged:payload.oilChanged===true,notes:String(payload.notes||''),after:{confirmed:payload.after.confirmed===true,reading:reading(payload.after.reading),presence:payload.after.presence},status:'completed'});
      if(trip.oilChanged) next.oil[trip.vehicleId]=end;
      return {trip,rowNumber:next.trips.filter(t=>t.vehicleId===trip.vehicleId).length+1,sheetUrl:null};
    });},
    async getTrip(id){const trip=state.trips.find(t=>t.id===id);requireValue(trip,'記録が見つかりません。','TRIP_NOT_FOUND');return {trip:copy(trip)};},
    async listHistory(id){vehicleFor(id);return {trips:copy(state.trips.filter(t=>t.vehicleId===id).slice().reverse())};}
  };
}
