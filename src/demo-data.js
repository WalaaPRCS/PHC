const today = new Date().toISOString().slice(0, 10);
const date = (daysAgo, hour = '09:00:00') => {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() - daysAgo);
  return `${value.toISOString().slice(0, 10)}T${hour}Z`;
};

export const demoRecords = [
  { resource: 'clinics', records: [
    { id: 'clinic-demo-ramallah', code: 'DEMO-RAM', name: 'عيادة تجريبية — رام الله', location: 'رام الله', address: 'بيانات موقع تجريبية', phone: '', status: 'فعالة', services: ['طب عام','تمريض','تطعيم','مختبر','صيدلية','تغذية'] },
    { id: 'clinic-demo-nablus', code: 'DEMO-NAB', name: 'عيادة تجريبية — نابلس', location: 'نابلس', address: 'بيانات موقع تجريبية', phone: '', status: 'فعالة', services: ['طب عام','تمريض','تطعيم','مختبر','صيدلية'] },
  ] },
  { resource: 'staff', records: [
    { id: 'staff-demo-doctor-1', employeeCode: 'DEMO-EMP-01', clinicId: 'clinic-demo-ramallah', name: 'طبيب تجريبي ١', jobTitle: 'طبيب', specialtyService: 'طب عام', phone: '', status: 'نشط', services: ['طب عام'], demo: true },
    { id: 'staff-demo-nurse-1', employeeCode: 'DEMO-EMP-02', clinicId: 'clinic-demo-ramallah', name: 'ممرض تجريبي ١', jobTitle: 'ممرض', specialtyService: '', phone: '', status: 'نشط', services: ['تمريض','تطعيم'], demo: true },
    { id: 'staff-demo-lab-1', employeeCode: 'DEMO-EMP-03', clinicId: 'clinic-demo-ramallah', name: 'فني مختبر تجريبي ١', jobTitle: 'فني مختبر', specialtyService: '', phone: '', status: 'نشط', services: ['مختبر'], demo: true },
    { id: 'staff-demo-doctor-2', employeeCode: 'DEMO-EMP-04', clinicId: 'clinic-demo-nablus', name: 'طبيب تجريبي ٢', jobTitle: 'طبيب', specialtyService: 'طب عام', phone: '', status: 'نشط', services: ['طب عام'], demo: true },
  ] },
  { resource: 'projects', records: [
    { id: 'project-demo-primary-care', code: 'DEMO-PC-2026', name: 'مشروع تجريبي — دعم الرعاية الأولية', donor: 'جهة مانحة تجريبية', start: `${today.slice(0, 4)}-01-01`, end: `${today.slice(0, 4)}-12-31`, status: 'نشط', description: 'سجل افتراضي للتجربة فقط؛ لا يمثل تمويلاً حقيقياً.', services: [
      { name: 'طب عام', goal: 'تحسين الوصول إلى الاستشارات الطبية الأولية.' },
      { name: 'تطعيم', goal: 'رفع تغطية التطعيمات الأساسية.' },
      { name: 'مختبر', goal: 'توفير الفحوصات التشخيصية الأساسية.' },
    ], indicators: [
      { id: 'demo-ind-consultations', service: 'طب عام', name: 'عدد الاستشارات الطبية', unit: 'استشارة', baseline: 0, target: 1200, frequency: 'شهري' },
      { id: 'demo-ind-vaccines', service: 'تطعيم', name: 'عدد جرعات التطعيم', unit: 'جرعة', baseline: 0, target: 800, frequency: 'شهري' },
      { id: 'demo-ind-tests', service: 'مختبر', name: 'عدد الفحوصات المخبرية', unit: 'فحص', baseline: 0, target: 600, frequency: 'شهري' },
    ] },
    { id: 'project-demo-maternal', code: 'DEMO-MCH-2026', name: 'مشروع تجريبي — صحة الأم والطفل', donor: 'جهة مانحة تجريبية', start: `${today.slice(0, 4)}-01-01`, end: `${today.slice(0, 4)}-12-31`, status: 'نشط', description: 'بيانات افتراضية لشرح ربط أكثر من مشروع بالعيادة.', services: [
      { name: 'تغذية', goal: 'تحسين خدمات التثقيف والتقييم الغذائي.' },
      { name: 'تمريض', goal: 'تعزيز الرعاية التمريضية والمتابعة.' },
    ], indicators: [
      { id: 'demo-ind-nutrition', service: 'تغذية', name: 'جلسات التوعية الغذائية', unit: 'جلسة', baseline: 0, target: 300, frequency: 'ربع سنوي' },
      { id: 'demo-ind-nursing', service: 'تمريض', name: 'زيارات الرعاية التمريضية', unit: 'زيارة', baseline: 0, target: 500, frequency: 'شهري' },
    ] },
  ] },
  { resource: 'allocations', records: [
    { id: 'demo-allocation-ram-consult', clinicId: 'clinic-demo-ramallah', projectId: 'project-demo-primary-care', service: 'طب عام', indicatorId: 'demo-ind-consultations', goal: 'تغطية الاستشارات الطبية الأولية في العيادة.', target: 600, percent: 70, start: `${today.slice(0, 4)}-01-01`, end: `${today.slice(0, 4)}-12-31`, active: true },
    { id: 'demo-allocation-ram-vaccine', clinicId: 'clinic-demo-ramallah', projectId: 'project-demo-primary-care', service: 'تطعيم', indicatorId: 'demo-ind-vaccines', goal: 'توفير جرعات التطعيم الأساسية.', target: 400, percent: 75, start: `${today.slice(0, 4)}-01-01`, end: `${today.slice(0, 4)}-12-31`, active: true },
    { id: 'demo-allocation-ram-lab', clinicId: 'clinic-demo-ramallah', projectId: 'project-demo-primary-care', service: 'مختبر', indicatorId: 'demo-ind-tests', goal: 'دعم الفحوصات المخبرية المرتبطة بالرعاية الأولية.', target: 300, percent: 60, start: `${today.slice(0, 4)}-01-01`, end: `${today.slice(0, 4)}-12-31`, active: true },
    { id: 'demo-allocation-nab-consult', clinicId: 'clinic-demo-nablus', projectId: 'project-demo-primary-care', service: 'طب عام', indicatorId: 'demo-ind-consultations', goal: 'تغطية الاستشارات الطبية الأولية في العيادة.', target: 600, percent: 30, start: `${today.slice(0, 4)}-01-01`, end: `${today.slice(0, 4)}-12-31`, active: true },
    { id: 'demo-allocation-ram-nutrition', clinicId: 'clinic-demo-ramallah', projectId: 'project-demo-maternal', service: 'تغذية', indicatorId: 'demo-ind-nutrition', goal: 'تمويل جلسات التوعية والتقييم الغذائي.', target: 180, percent: 60, start: `${today.slice(0, 4)}-01-01`, end: `${today.slice(0, 4)}-12-31`, active: true },
    { id: 'demo-allocation-ram-nursing', clinicId: 'clinic-demo-ramallah', projectId: 'project-demo-maternal', service: 'تمريض', indicatorId: 'demo-ind-nursing', goal: 'تمويل خدمات الرعاية التمريضية والمتابعة.', target: 300, percent: 60, start: `${today.slice(0, 4)}-01-01`, end: `${today.slice(0, 4)}-12-31`, active: true },
  ] },
  { resource: 'patients', records: [
    { id: 'PR-DEMO-001', fileNo: 'PR-DEMO-001', name: 'مريض تجريبي 001', gender: 'ذكر', dateOfBirth: '1990-01-01', age: 36, phone: '', address: 'بيانات عنوان تجريبية', clinic: 'عيادة تجريبية — رام الله', clinicId: 'clinic-demo-ramallah', bloodType: 'غير محدد', demo: true, visits: [
      { id: 'visit-demo-001', date: date(8), clinic: 'عيادة تجريبية — رام الله', clinicId: 'clinic-demo-ramallah', service: 'طب عام', type: 'زيارة سريرية', status: 'مكتملة', provider: 'طبيب تجريبي ١', providerStaffId: 'staff-demo-doctor-1', complaint: 'صداع وإرهاق منذ يومين (سيناريو تجريبي).', history: 'لا توجد معلومات مرضية سابقة في هذه العينة.', diagnosis: 'صداع غير محدد', assessment: 'حالة مستقرة؛ بيانات تدريبية.', plan: 'الراحة وشرب السوائل والمتابعة عند استمرار الأعراض.', vitals: { 'ضغط الدم': '118/76', 'النبض': '76', 'الحرارة': '36.8', 'الوزن': '68' }, medications: [{ name: 'باراسيتامول · 500 ملغ', dose: 'قرص واحد عند اللزوم', duration: 'يومان', quantity: '1 علبة' }], procedures: [], referral: 'إحالة تجريبية إلى قسم الطوارئ.', referrals: [{ id: 'referral-demo-001', type: 'طوارئ', destination: 'قسم الطوارئ التجريبي', urgency: 'اعتيادية', reason: 'بيانات إحالة افتراضية لعرض شاشة الإحالات.', status: 'مفتوحة', createdAt: date(8) }], funding: { projectId: 'project-demo-primary-care', projectName: 'مشروع تجريبي — دعم الرعاية الأولية', indicatorId: 'demo-ind-consultations', indicatorName: 'عدد الاستشارات الطبية', goal: 'تغطية الاستشارات الطبية الأولية في العيادة.', target: 600 } },
      { id: 'visit-demo-002', date: date(2, '10:30:00'), clinic: 'عيادة تجريبية — نابلس', clinicId: 'clinic-demo-nablus', service: 'طب عام', type: 'زيارة سريرية', status: 'مكتملة', provider: 'طبيب تجريبي ٢', providerStaffId: 'staff-demo-doctor-2', complaint: 'متابعة دورية (سيناريو تجريبي).', history: 'زيارة سابقة في عيادة أخرى ضمن النظام.', diagnosis: 'متابعة صحية عامة', assessment: 'مستقر؛ لا توجد ملاحظات عاجلة.', plan: 'الاستمرار بالمتابعة حسب الحاجة.', vitals: { 'ضغط الدم': '120/78', 'النبض': '72', 'الحرارة': '36.7' }, medications: [], procedures: [], referral: 'لا توجد إحالة مسجلة.' },
    ] },
    { id: 'PR-DEMO-002', fileNo: 'PR-DEMO-002', name: 'مريضة تجريبية 002', gender: 'أنثى', dateOfBirth: '2015-06-15', age: 11, phone: '', address: 'بيانات عنوان تجريبية', clinic: 'عيادة تجريبية — رام الله', clinicId: 'clinic-demo-ramallah', bloodType: 'غير محدد', demo: true, visits: [
      { id: 'visit-demo-003', date: date(1, '11:15:00'), clinic: 'عيادة تجريبية — رام الله', clinicId: 'clinic-demo-ramallah', service: 'تطعيم', type: 'زيارة تطعيم', status: 'مكتملة', provider: 'ممرض تجريبي ١', providerStaffId: 'staff-demo-nurse-1', complaint: 'زيارة تطعيم مجدولة (سيناريو تجريبي).', assessment: 'تم التحقق من سجل التطعيم التجريبي.', plan: 'المتابعة وفق الجدول الوطني المعتمد.', vitals: {}, medications: [], procedures: ['إعطاء جرعة تطعيم تجريبية'], referral: 'لا توجد إحالة مسجلة.' },
    ] },
  ] },
  { resource: 'visits', records: [
    { id: 'visit-demo-001', fileNo: 'PR-DEMO-001', date: date(8), clinic: 'عيادة تجريبية — رام الله', clinicId: 'clinic-demo-ramallah', service: 'طب عام', type: 'زيارة سريرية', status: 'مكتملة', provider: 'طبيب تجريبي ١', complaint: 'صداع وإرهاق منذ يومين (سيناريو تجريبي).', diagnosis: 'صداع غير محدد', assessment: 'حالة مستقرة؛ بيانات تدريبية.', plan: 'الراحة وشرب السوائل والمتابعة عند استمرار الأعراض.', vitals: { 'ضغط الدم': '118/76', 'النبض': '76', 'الحرارة': '36.8' }, medications: [{ name: 'باراسيتامول · 500 ملغ', dose: 'قرص واحد عند اللزوم', duration: 'يومان', quantity: '1 علبة' }], procedures: [], referral: 'إحالة تجريبية إلى قسم الطوارئ.', referrals: [{ id: 'referral-demo-001', type: 'طوارئ', destination: 'قسم الطوارئ التجريبي', urgency: 'اعتيادية', reason: 'بيانات إحالة افتراضية لعرض شاشة الإحالات.', status: 'مفتوحة', createdAt: date(8) }] },
    { id: 'visit-demo-002', fileNo: 'PR-DEMO-001', date: date(2, '10:30:00'), clinic: 'عيادة تجريبية — نابلس', clinicId: 'clinic-demo-nablus', service: 'طب عام', type: 'زيارة سريرية', status: 'مكتملة', provider: 'طبيب تجريبي ٢', complaint: 'متابعة دورية (سيناريو تجريبي).', diagnosis: 'متابعة صحية عامة', assessment: 'مستقر؛ لا توجد ملاحظات عاجلة.', plan: 'الاستمرار بالمتابعة حسب الحاجة.', vitals: { 'ضغط الدم': '120/78', 'النبض': '72' }, medications: [], procedures: [], referral: 'لا توجد إحالة مسجلة.' },
    { id: 'visit-demo-003', fileNo: 'PR-DEMO-002', date: date(1, '11:15:00'), clinic: 'عيادة تجريبية — رام الله', clinicId: 'clinic-demo-ramallah', service: 'تطعيم', type: 'زيارة تطعيم', status: 'مكتملة', provider: 'ممرض تجريبي ١', complaint: 'زيارة تطعيم مجدولة (سيناريو تجريبي).', diagnosis: '', assessment: 'تم التحقق من سجل التطعيم التجريبي.', plan: 'المتابعة وفق الجدول الوطني المعتمد.', vitals: {}, medications: [], procedures: ['إعطاء جرعة تطعيم تجريبية'], referral: 'لا توجد إحالة مسجلة.' },
  ] },
  { resource: 'immunizations', records: [
    { id: 'immunization-demo-001', fileNo: 'PR-DEMO-002', patientName: 'مريضة تجريبية 002', clinic: 'عيادة تجريبية — رام الله', clinicId: 'clinic-demo-ramallah', vaccine: 'لقاح الحصبة والنكاف والحصبة الألمانية', vaccineCode: 'DEMO-MMR', dose: 'جرعة تجريبية', date: today, dueDate: '', batch: 'DEMO-VAX-01', status: 'أُعطي', provider: 'ممرض تجريبي ١', visitId: 'visit-demo-003', demo: true },
    { id: 'immunization-demo-002', fileNo: 'PR-DEMO-001', patientName: 'مريض تجريبي 001', clinic: 'عيادة تجريبية — نابلس', clinicId: 'clinic-demo-nablus', vaccine: 'لقاح الإنفلونزا', vaccineCode: 'DEMO-FLU', dose: 'جرعة تجريبية', date: '', dueDate: today, batch: '', status: 'مجدول', provider: 'ممرض تجريبي', demo: true },
  ] },
  { resource: 'lab_orders', records: [
    { id: 'lab-demo-001', fileNo: 'PR-DEMO-001', patientName: 'مريض تجريبي 001', visitId: 'visit-demo-001', visitService: 'طب عام', clinic: 'عيادة تجريبية — رام الله', clinicId: 'clinic-demo-ramallah', testName: 'تعداد دم كامل (CBC)', specimen: 'دم', priority: 'عادي', requestedBy: 'طبيب تجريبي ١', requestNotes: 'طلب تجريبي للتوضيح.', requestedAt: date(8), status: 'مكتمل', resultValue: 'ضمن الحدود المرجعية للعينة', resultUnit: '', referenceRange: 'حسب مرجع المختبر', resultNotes: 'نتيجة افتراضية للتجربة فقط؛ لا تستخدم لاتخاذ قرار علاجي.', performedBy: 'فني مختبر تجريبي ١', resultAt: date(8), demo: true },
    { id: 'lab-demo-002', fileNo: 'PR-DEMO-002', patientName: 'مريضة تجريبية 002', visitId: 'visit-demo-003', visitService: 'تطعيم', clinic: 'عيادة تجريبية — رام الله', clinicId: 'clinic-demo-ramallah', testName: 'سكر عشوائي', specimen: 'دم', priority: 'عادي', requestedBy: 'طبيب تجريبي ١', requestNotes: 'طلب تجريبي.', requestedAt: date(1), status: 'مطلوب', resultValue: '', resultUnit: '', referenceRange: '', resultNotes: '', performedBy: '', demo: true },
  ] },
  { resource: 'queue', records: [
    { id: 'ticket-demo-001', ticketNo: 'D-001', dateKey: today.replaceAll('-', ''), createdAt: date(0, '08:30:00'), patientFileNo: 'PR-DEMO-001', patientName: 'مريض تجريبي 001', gender: 'ذكر', age: 36, clinicId: 'clinic-demo-ramallah', clinicName: 'عيادة تجريبية — رام الله', service: 'طب عام', providerId: 'staff-demo-doctor-1', providerName: 'طبيب تجريبي ١', status: 'بانتظار الدخول', visitId: '', demo: true },
  ] },
];

export async function seedDemoData(pool, syncNormalized) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['phc-demo-seed-v1']);
    const exists = await client.query("SELECT 1 FROM app_records WHERE resource='system_meta' AND record_id='demo-seed-v1'");
    if (exists.rowCount) { await client.query('COMMIT'); return false; }
    for (const group of demoRecords) {
      for (const record of group.records) {
        const id = String(record.id || record.fileNo || record.code);
        const clinicRef = record.clinicId || null;
        await client.query(
          `INSERT INTO app_records(resource,record_id,clinic_ref,payload)
           VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(resource,record_id) DO NOTHING`,
          [group.resource, id, clinicRef, JSON.stringify(record)],
        );
        try {
          await syncNormalized(client, group.resource, record, id);
        } catch (error) {
          throw new Error(`تعذر تجهيز العينة ${group.resource}/${id}: ${error.message}`, { cause: error });
        }
      }
    }
    await client.query("INSERT INTO app_records(resource,record_id,payload) VALUES('system_meta','demo-seed-v1',jsonb_build_object('createdAt',now(),'label','بيانات تجريبية')) ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
